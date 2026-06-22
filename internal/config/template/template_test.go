package template

import (
	"strings"
	"testing"
)

func TestLoadDefault_FieldsPopulated(t *testing.T) {
	tpl, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault() error: %v", err)
	}

	if len(tpl.MainTask.Messages) != 2 {
		t.Errorf("MainTask.Messages length = %d, want 2", len(tpl.MainTask.Messages))
	}
	for i, msg := range tpl.MainTask.Messages {
		if msg.Content == "" {
			t.Errorf("MainTask.Messages[%d].Content is empty", i)
		}
	}
	if tpl.MainTask.Timeout != 120 {
		t.Errorf("MainTask.Timeout = %d, want 120", tpl.MainTask.Timeout)
	}
	if tpl.PlanTask == nil {
		t.Fatal("PlanTask is nil, expected non-nil")
	}
	if len(tpl.PlanTask.Messages) != 2 {
		t.Errorf("PlanTask.Messages length = %d, want 2", len(tpl.PlanTask.Messages))
	}
	if tpl.ReLocationTask == nil {
		t.Fatal("ReLocationTask is nil, expected non-nil")
	}
	if tpl.ReviewFilterTask == nil {
		t.Fatal("ReviewFilterTask is nil, expected non-nil")
	}
	if tpl.MaxTokens != 58888 {
		t.Errorf("MaxTokens = %d, want 58888", tpl.MaxTokens)
	}
	if tpl.MaxToolRequestTimes != 30 {
		t.Errorf("MaxToolRequestTimes = %d, want 30", tpl.MaxToolRequestTimes)
	}
	if tpl.PlanModeLineThreshold != 50 {
		t.Errorf("PlanModeLineThreshold = %d, want 50", tpl.PlanModeLineThreshold)
	}
}

func TestLoadDefault_PlaceholdersPresent(t *testing.T) {
	tpl, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault() error: %v", err)
	}

	tests := []struct {
		name        string
		content     string
		placeholder string
	}{
		{"MainTask user has current_file_path", tpl.MainTask.Messages[1].Content, "{{current_file_path}}"},
		{"MainTask user has diff", tpl.MainTask.Messages[1].Content, "{{diff}}"},
		{"PlanTask system has plan_tools", tpl.PlanTask.Messages[0].Content, "{{plan_tools}}"},
		{"MemoryCompression user has context", tpl.MemoryCompressionTask.Messages[1].Content, "{{context}}"},
		{"ReviewFilter user has comments", tpl.ReviewFilterTask.Messages[1].Content, "{{comments}}"},
		{"ReLocation user has diff (single brace)", tpl.ReLocationTask.Messages[1].Content, "{diff}"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !strings.Contains(tt.content, tt.placeholder) {
				t.Errorf("content does not contain %q", tt.placeholder)
			}
		})
	}
}

func TestValidate_PassesOnDefault(t *testing.T) {
	tpl, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault() error: %v", err)
	}
	if err := tpl.Validate(); err != nil {
		t.Errorf("Validate() error: %v", err)
	}
}

func TestApplyLanguage(t *testing.T) {
	tpl, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault() error: %v", err)
	}

	tpl.ApplyLanguage("Chinese")
	suffix := "\n\nAlways respond in Chinese."
	if !strings.HasSuffix(tpl.MainTask.Messages[0].Content, suffix) {
		t.Errorf("MainTask system message does not end with %q", suffix)
	}
	if !strings.HasSuffix(tpl.PlanTask.Messages[0].Content, suffix) {
		t.Errorf("PlanTask system message does not end with %q", suffix)
	}
	if !strings.HasSuffix(tpl.MemoryCompressionTask.Messages[0].Content, suffix) {
		t.Errorf("MemoryCompressionTask system message does not end with %q", suffix)
	}
}

func TestApplyLanguage_DefaultEnglish(t *testing.T) {
	tpl, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault() error: %v", err)
	}

	tpl.ApplyLanguage("")
	suffix := "\n\nAlways respond in English."
	if !strings.HasSuffix(tpl.MainTask.Messages[0].Content, suffix) {
		t.Errorf("MainTask system message does not end with %q", suffix)
	}
}
