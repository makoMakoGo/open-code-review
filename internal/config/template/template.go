// Package template loads and validates task prompt templates for the code review agent.
package template

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
)

// Template holds the native agent task template configuration.
type Template struct {
	MainTask              LlmConversation  `json:"MAIN_TASK"`
	PlanTask              *LlmConversation `json:"PLAN_TASK,omitempty"`
	MemoryCompressionTask LlmConversation  `json:"MEMORY_COMPRESSION_TASK"`
	MaxTokens             int              `json:"MAX_TOKENS"`
	MaxToolRequestTimes   int              `json:"MAX_TOOL_REQUEST_TIMES"`
	PlanModeLineThreshold int              `json:"PLAN_MODE_LINE_THRESHOLD"`
	ReLocationTask        *LlmConversation `json:"RE_LOCATION_TASK,omitempty"`
	ReviewFilterTask      *LlmConversation `json:"REVIEW_FILTER_TASK,omitempty"`
}

//go:embed task_template.json prompts/*
var templateFS embed.FS

type manifestMessage struct {
	Role       string `json:"role"`
	PromptFile string `json:"prompt_file"`
}

type manifestConversation struct {
	Timeout  int               `json:"timeout"`
	Messages []manifestMessage `json:"messages"`
}

type templateManifest struct {
	MainTask              manifestConversation  `json:"MAIN_TASK"`
	PlanTask              *manifestConversation `json:"PLAN_TASK,omitempty"`
	MemoryCompressionTask manifestConversation  `json:"MEMORY_COMPRESSION_TASK"`
	MaxTokens             int                   `json:"MAX_TOKENS"`
	MaxToolRequestTimes   int                   `json:"MAX_TOOL_REQUEST_TIMES"`
	PlanModeLineThreshold int                   `json:"PLAN_MODE_LINE_THRESHOLD"`
	ReLocationTask        *manifestConversation `json:"RE_LOCATION_TASK,omitempty"`
	ReviewFilterTask      *manifestConversation `json:"REVIEW_FILTER_TASK,omitempty"`
}

func resolveConversation(m manifestConversation) (LlmConversation, error) {
	conv := LlmConversation{Timeout: m.Timeout}
	conv.Messages = make([]ChatMessage, len(m.Messages))
	for i, mm := range m.Messages {
		data, err := templateFS.ReadFile("prompts/" + mm.PromptFile)
		if err != nil {
			return LlmConversation{}, fmt.Errorf("read prompt file %q: %w", mm.PromptFile, err)
		}
		conv.Messages[i] = ChatMessage{
			Role:    mm.Role,
			Content: strings.TrimRight(string(data), "\r\n"),
		}
	}
	return conv, nil
}

func resolveOptionalConversation(m *manifestConversation, name string) (*LlmConversation, error) {
	if m == nil {
		return nil, nil
	}
	conv, err := resolveConversation(*m)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return &conv, nil
}

// LoadDefault parses the embedded task_template.json and resolves prompt file references.
func LoadDefault() (*Template, error) {
	data, err := templateFS.ReadFile("task_template.json")
	if err != nil {
		return nil, fmt.Errorf("read embedded task_template.json: %w", err)
	}
	var m templateManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("unmarshal task_template manifest: %w", err)
	}

	var tpl Template
	tpl.MaxTokens = m.MaxTokens
	tpl.MaxToolRequestTimes = m.MaxToolRequestTimes
	tpl.PlanModeLineThreshold = m.PlanModeLineThreshold

	if tpl.MainTask, err = resolveConversation(m.MainTask); err != nil {
		return nil, fmt.Errorf("MAIN_TASK: %w", err)
	}
	if tpl.PlanTask, err = resolveOptionalConversation(m.PlanTask, "PLAN_TASK"); err != nil {
		return nil, err
	}
	if tpl.MemoryCompressionTask, err = resolveConversation(m.MemoryCompressionTask); err != nil {
		return nil, fmt.Errorf("MEMORY_COMPRESSION_TASK: %w", err)
	}
	if tpl.ReLocationTask, err = resolveOptionalConversation(m.ReLocationTask, "RE_LOCATION_TASK"); err != nil {
		return nil, err
	}
	if tpl.ReviewFilterTask, err = resolveOptionalConversation(m.ReviewFilterTask, "REVIEW_FILTER_TASK"); err != nil {
		return nil, err
	}
	return &tpl, nil
}

// applyLanguage appends instruction to all system-role messages in conv.
func applyLanguage(conv *LlmConversation, instruction string) {
	for i := range conv.Messages {
		if conv.Messages[i].Role == "system" {
			conv.Messages[i].Content += instruction
		}
	}
}

// resolveLang returns the resolved language name for the instruction.
func resolveLang(lang string) string {
	if lang == "" {
		return "English"
	}
	return lang
}

// ApplyLanguage injects a language directive into all system-role messages
// across MAIN_TASK, PLAN_TASK (if set), and MEMORY_COMPRESSION_TASK.
func (t *Template) ApplyLanguage(lang string) {
	instruction := "\n\nAlways respond in " + resolveLang(lang) + "."
	applyLanguage(&t.MainTask, instruction)
	if t.PlanTask != nil {
		applyLanguage(t.PlanTask, instruction)
	}
	applyLanguage(&t.MemoryCompressionTask, instruction)
}
func (t *Template) Validate() error {
	if t.MaxTokens <= 0 {
		return fmt.Errorf("max_tokens must be positive")
	}
	if t.MaxToolRequestTimes <= 0 {
		return fmt.Errorf("max_tool_request_times must be positive")
	}
	if len(t.MainTask.Messages) == 0 {
		return fmt.Errorf("main_task.messages must not be empty")
	}
	return nil
}

// LlmConversation mirrors LlmConversation from the Java side — a preset prompt with settings.
type LlmConversation struct {
	Timeout  int           `json:"timeout"`
	Messages []ChatMessage `json:"messages"`
}

// ChatMessage represents a single message in a conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
