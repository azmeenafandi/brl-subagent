# Per-Preset Model Selection

## Goal

Allow presets to specify their own model. When a preset has a `model` field, subagents spawned with that preset use it. If the preset model is unavailable, fall back to the model configured via `/brl-subagent`.

## Motivation

Currently all presets use the single subagent model set via `/brl-subagent`. Different tasks benefit from different models:
- `security-auditor` → a strong reasoning model (e.g., `anthropic/claude-opus-4-6`)
- `rapid-prototyper` → a fast cheap model (e.g., `deepseek-v4-flash`)
- `tech-writer` → a mid-tier model

## Changes

### 1. `src/types.ts` — add field

```typescript
export interface SubagentPreset {
    name: string;
    description?: string;
    systemPrompt?: string;
    inheritSystemPrompt?: boolean;
    thinkingLevel?: string;
    model?: string;        // NEW: "provider/model-id", e.g. "anthropic/claude-opus-4-6"
    outputFile?: string;
    timeout?: number;
    tools?: string[];
    excludeTools?: string[];
    noBuiltinTools?: boolean;
    promptGuideline?: string;
}
```

### 2. `src/presets.ts` — parse `model` field

In both `loadBuiltinPresets()` and `loadCustomPresets()`, after `thinkingLevel` parsing:

```typescript
model: (meta.model as string) || undefined,
```

### 3. `src/index.ts` — model resolution with preset

Modify `resolveSubagentModel()` to accept an optional preset:

```typescript
function resolveSubagentModel(
    ctx: ExtensionContext,
    preset?: SubagentPreset,
):
    | { ok: true; model: { provider: string; id: string } }
    | { ok: false; error: AgentToolResult<SubagentResult> } {

    // Precedence: preset.model > state.config.model > conductor model
    let subagentModel: { provider: string; id: string } | undefined;

    if (preset?.model) {
        const parsed = parseModelString(preset.model);
        if (parsed && modelIsAvailable(ctx, parsed)) {
            subagentModel = parsed;
            log.info("Using preset model", { preset: preset.name, model: preset.model });
        } else {
            // Fallback: preset model unavailable → configured model
            log.warn("Preset model unavailable, falling back to configured model", {
                preset: preset.name,
                model: preset.model,
            });
        }
    }

    if (!subagentModel) {
        subagentModel =
            state.config.model ||
            (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
    }

    if (!subagentModel) {
        return {
            ok: false,
            error: {
                content: [{ type: "text" as const, text: "No model available. Configure API keys first, then use /brl-subagent to set a model." }],
                isError: true,
            },
        };
    }
    return { ok: true, model: subagentModel };
}
```

### 4. Helpers

```typescript
/** Parse "provider/model-id" into {provider, id}. Returns null on bad format. */
function parseModelString(s: string): { provider: string; id: string } | null {
    const idx = s.indexOf("/");
    if (idx <= 0 || idx === s.length - 1) return null;
    return { provider: s.slice(0, idx), id: s.slice(idx + 1) };
}

/** Check if provider/model combo exists in the model registry. */
function modelIsAvailable(ctx: ExtensionContext, m: { provider: string; id: string }): boolean {
    try {
        const registry = ctx.modelRegistry;
        // If registry has getAll/get, use it; otherwise fallback to trusting the string
        const models = registry?.getAll?.() ?? [];
        return models.some((x) => x.provider === m.provider && x.id === m.id);
    } catch {
        return false;
    }
}
```

Note: `ctx.modelRegistry` API shape must be verified against the pi SDK before implementation.

### 5. Update all call sites

`resolveSubagentModel(ctx)` → `resolveSubagentModel(ctx, preset)` in all 4 places:
- Single mode execute handler
- Chain mode
- Parallel mode
- Graph mode

## Preset file example

```yaml
---
name: security-auditor
description: Security review with a strong reasoning model
model: anthropic/claude-opus-4-6
thinking: high
tools:
  - read
  - grep
  - find
  - bash
---
You are a security auditor...
```

## Fallback behavior

| Case | Result |
|------|--------|
| Preset model available | Uses preset model |
| Preset model unavailable | Warn + use `/brl-subagent` configured model |
| No preset model | Uses `/brl-subagent` configured model |
| No model at all | Error: "No model available" |

## Testing

- Preset with valid model → subagent spawned with that model
- Preset with invalid model → fallback warning + configured model used
- Preset without model → configured model used
- Chain/parallel/graph modes pass preset through correctly
