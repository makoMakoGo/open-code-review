package agent

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/open-code-review/open-code-review/internal/llm"
	"github.com/open-code-review/open-code-review/internal/session"
	"github.com/open-code-review/open-code-review/internal/stdout"
	"github.com/open-code-review/open-code-review/internal/tool"
)

// compression thresholds as fractions of MaxTokens.
const (
	tokenSoftThreshold    = 0.60 // async background compression
	tokenWarningThreshold = 0.80 // immediate sync compression
)

// round groups consecutive messages starting with an assistant message
// followed by zero or more tool result messages.
type round struct {
	assistantIdx int
	toolIdxs     []int
}

// partitionResult describes how messages should be split for compression.
type partitionResult struct {
	frozenEnd   int
	compressEnd int
	rounds      []round
	activeCount int
}

// compressionJob tracks an in-flight background compression operation.
type compressionJob struct {
	done        chan struct{}
	rebuilt     []llm.Message
	cancel      context.CancelFunc
	snapshotLen int // message count when the snapshot was taken
}

// groupIntoRounds parses messages[start:] into logical (assistant + tool_results) pairs.
func groupIntoRounds(messages []llm.Message, start int) []round {
	var rounds []round
	i := start
	for i < len(messages) {
		if messages[i].Role == "assistant" {
			r := round{assistantIdx: i}
			i++
			for i < len(messages) && messages[i].Role == "tool" {
				r.toolIdxs = append(r.toolIdxs, i)
				i++
			}
			rounds = append(rounds, r)
		} else {
			i++
		}
	}
	return rounds
}

// computeActiveZoneSize returns how many trailing rounds fit within the remaining
// token budget after accounting for frozen zone and the compressed summary.
func computeActiveZoneSize(rounds []round, messages []llm.Message, maxTokens int, reservedTokens int) int {
	budget := int(float64(maxTokens)*tokenWarningThreshold) - reservedTokens
	if budget <= 0 {
		return 0
	}

	count := 0
	tokensUsed := 0
	for i := len(rounds) - 1; i >= 0; i-- {
		roundTokens := llm.CountTokens(messages[rounds[i].assistantIdx].ExtractText())
		for _, ti := range rounds[i].toolIdxs {
			roundTokens += llm.CountTokens(messages[ti].ExtractText())
		}
		if tokensUsed+roundTokens > budget {
			break
		}
		tokensUsed += roundTokens
		count++
	}
	return count
}

// partitionMessages divides messages into frozen, compress, and active zones.
// Frozen zone is always messages[0:2]. Active zone preserves the K most recent
// complete rounds based on available token budget.
func partitionMessages(messages []llm.Message, maxTokens int, prevSummaryTokenEstimate int) partitionResult {
	result := partitionResult{frozenEnd: 2}
	if len(messages) <= 2 {
		result.compressEnd = len(messages)
		return result
	}

	result.rounds = groupIntoRounds(messages, 2)
	if len(result.rounds) == 0 {
		result.compressEnd = len(messages)
		return result
	}

	result.activeCount = computeActiveZoneSize(result.rounds, messages, maxTokens, prevSummaryTokenEstimate)
	if result.activeCount >= len(result.rounds) {
		// Everything fits — no compression needed.
		result.compressEnd = len(messages)
		result.activeCount = 0
		return result
	}

	// compressEnd = index after the last round NOT in active zone.
	activeStartIdx := len(result.rounds) - result.activeCount
	lastCompressRound := result.rounds[activeStartIdx-1]
	if len(lastCompressRound.toolIdxs) > 0 {
		result.compressEnd = lastCompressRound.toolIdxs[len(lastCompressRound.toolIdxs)-1] + 1
	} else {
		result.compressEnd = lastCompressRound.assistantIdx + 1
	}

	return result
}

// addNextMessage adds assistant + tool response messages to the conversation history.
// Implements dual-threshold compression:
//   - 60% of MaxTokens: trigger async background compression (non-blocking)
//   - 80% of MaxTokens: perform synchronous compression immediately
func (a *Agent) addNextMessage(ctx context.Context, assistantContent string, toolCalls []llm.ToolCall, results []tool.ToolCallResult, messages *[]llm.Message, filePath string) bool {
	maxAllowed := a.args.Template.MaxTokens
	softLimit := int(float64(maxAllowed) * tokenSoftThreshold)
	warnLimit := int(float64(maxAllowed) * tokenWarningThreshold)

	// Try to apply any completed async compression from a previous iteration.
	a.tryApplyPendingCompression(messages)

	tokenCount := countMessagesTokens(*messages)

	// Hard threshold: synchronous compression.
	if tokenCount > warnLimit {
		a.cancelPendingCompression()
		*messages, _ = a.runCompression(ctx, *messages, filePath)
		tokenCount = countMessagesTokens(*messages)
	}

	// Soft threshold: async compression.
	if tokenCount > softLimit && a.pendingJob == nil {
		a.triggerAsyncCompression(ctx, *messages, filePath)
	}

	// Add assistant message with tool_calls when present.
	if len(toolCalls) > 0 {
		*messages = append(*messages, llm.NewToolCallMessage(assistantContent, toolCalls))
	} else if assistantContent != "" {
		*messages = append(*messages, llm.NewTextMessage("assistant", assistantContent))
	}

	// Add tool response messages using Claude's tool_result format.
	for _, r := range results {
		*messages = append(*messages, llm.NewToolResultMessage(r.ToolCallID, r.Result))
	}

	// Final check: compress synchronously if still over warning limit.
	finalCount := countMessagesTokens(*messages)
	if finalCount > warnLimit {
		a.cancelPendingCompression()
		*messages, _ = a.runCompression(ctx, *messages, filePath)
		finalCount = countMessagesTokens(*messages)
	}

	return finalCount < warnLimit
}

// runCompression performs three-zone memory compression on the given messages.
// It summarizes the compress zone while preserving the active zone intact.
// Returns the rebuilt messages slice: [frozen] + [compressed_summary] + [active].
func (a *Agent) runCompression(ctx context.Context, msgs []llm.Message, filePath string) ([]llm.Message, error) {
	if len(a.args.Template.MemoryCompressionTask.Messages) == 0 || len(msgs) <= 2 {
		return msgs[:min(len(msgs), 2)], nil
	}

	part := partitionMessages(msgs, a.args.Template.MaxTokens, 0)
	if part.compressEnd <= part.frozenEnd {
		return msgs, nil
	}

	contextXML := buildMessageXML(msgs[part.frozenEnd:part.compressEnd])

	compressionMsgs := make([]llm.Message, 0, len(a.args.Template.MemoryCompressionTask.Messages))
	for _, m := range a.args.Template.MemoryCompressionTask.Messages {
		content := strings.ReplaceAll(m.Content, "{{context}}", contextXML)
		compressionMsgs = append(compressionMsgs, llm.NewTextMessage(m.Role, content))
	}

	startTime := time.Now()
	resp, err := a.args.LLMClient.CompletionsWithCtx(ctx, llm.ChatRequest{
		Model:     a.args.Model,
		Messages:  compressionMsgs,
		MaxTokens: a.args.Template.MaxTokens,
	})
	duration := time.Since(startTime)

	fs := a.session.GetOrCreateFileSession(filePath)
	rec := fs.AppendTaskRecord(session.MemoryCompressionTask, compressionMsgs)
	if err != nil {
		rec.SetError(err, duration)
		fmt.Fprintf(stdout.Writer(), "[ocr] Memory compression failed: %v\n", err)
		// Intentionally return unmodified msgs: truncating to frozenEnd would
		// discard all conversation context, which is worse than staying over
		// the token limit temporarily.
		return msgs, fmt.Errorf("memory compression: %w", err)
	}
	rec.SetResponse(resp, duration)
	if resp.Usage != nil {
		atomic.AddInt64(&a.totalInputTokens, resp.Usage.PromptTokens)
		atomic.AddInt64(&a.totalOutputTokens, resp.Usage.CompletionTokens)
		atomic.AddInt64(&a.totalCacheReadTokens, resp.Usage.CacheReadTokens)
		atomic.AddInt64(&a.totalCacheWriteTokens, resp.Usage.CacheWriteTokens)
	}

	rawSummary := stripMarkdownFences(resp.Content())
	if rawSummary == "" {
		return msgs, nil
	}

	rebuilt := make([]llm.Message, 2)
	copy(rebuilt, msgs[:2])

	userMsg := rebuilt[1]
	currentText := userMsg.ExtractText()
	if idx := strings.Index(currentText, "\n\n<previous_review_summary>"); idx >= 0 {
		currentText = currentText[:idx]
	}
	rebuilt[1] = llm.NewTextMessage(userMsg.Role, currentText+"\n\n<previous_review_summary>\n"+rawSummary+"\n</previous_review_summary>")

	for i := part.compressEnd; i < len(msgs); i++ {
		rebuilt = append(rebuilt, msgs[i])
	}

	return rebuilt, nil
}

// triggerAsyncCompression kicks off a background compression job.
func (a *Agent) triggerAsyncCompression(ctx context.Context, messages []llm.Message, filePath string) {
	msgSnapshot := copyMessages(messages)

	asyncCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)

	job := &compressionJob{done: make(chan struct{}), cancel: cancel, snapshotLen: len(messages)}
	a.compressionMu.Lock()
	a.pendingJob = job
	a.compressionMu.Unlock()

	go func() {
		defer cancel()
		rebuilt, err := a.runCompression(asyncCtx, msgSnapshot, filePath)

		a.compressionMu.Lock()
		defer a.compressionMu.Unlock()

		if a.pendingJob != job {
			return // cancelled or superseded
		}
		if err != nil {
			a.pendingJob = nil
			close(job.done)
			return
		}
		job.rebuilt = rebuilt
		close(job.done)
	}()
}

// tryApplyPendingCompression checks if a background compression completed
// and swaps the rebuilt messages into place. Returns true if applied.
func (a *Agent) tryApplyPendingCompression(messages *[]llm.Message) bool {
	a.compressionMu.Lock()
	job := a.pendingJob
	a.compressionMu.Unlock()

	if job == nil {
		return false
	}

	select {
	case <-job.done:
		applied := false
		a.compressionMu.Lock()
		if a.pendingJob == job && job.rebuilt != nil {
			rebuilt := job.rebuilt
			if job.snapshotLen < len(*messages) {
				rebuilt = append(rebuilt, (*messages)[job.snapshotLen:]...)
			}
			*messages = rebuilt
			applied = true
		}
		if a.pendingJob == job {
			a.pendingJob = nil
		}
		a.compressionMu.Unlock()
		return applied
	default:
		return false
	}
}

// cancelPendingCompression aborts any in-flight background compression.
func (a *Agent) cancelPendingCompression() {
	a.compressionMu.Lock()
	defer a.compressionMu.Unlock()

	if a.pendingJob != nil {
		a.pendingJob.cancel()
		a.pendingJob = nil
	}
}
