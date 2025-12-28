# TypeScript/React Components

React components for meta prompt creation and markdown rendering.

---

## Components

### meta_prompt_creator.tsx

Advanced React component for creating and displaying meta prompts with sophisticated markdown rendering.

**Features:**
- Custom markdown parser (no external dependencies)
- Dark-themed UI with syntax highlighting
- Supports headers, code blocks, lists, blockquotes, bold, italic
- Nested list support (disc, circle, square for unordered)
- Monospace font for code with amber highlighting

**Styling:**
- Dark background (`#1f2937`, `#374151`)
- Light text (`#e5e7eb`, `#ffffff`)
- Indigo accent for blockquotes (`#6366f1`)
- Amber accent for inline code (`#fbbf24`)

---

### meta_prompt_creator_simplified.tsx

Simplified version with the same markdown rendering but streamlined functionality for basic use cases.

---

## Usage

These are standalone React components. To use:

1. Copy the component file into your React project
2. Import and use:

```tsx
import MetaPromptCreator from './meta_prompt_creator';

function App() {
  return <MetaPromptCreator />;
}
```

**Dependencies:**
- React 16.8+ (uses hooks)
- TypeScript (optional but recommended)

---

## Markdown Support

| Element | Syntax |
|---------|--------|
| Headers | `#`, `##`, `###`, `####` |
| Bold | `**text**` |
| Italic | `*text*` |
| Bold+Italic | `***text***` |
| Inline code | `` `code` `` |
| Code block | ` ```language ... ``` ` |
| Blockquote | `> text` |
| Unordered list | `- item` or `* item` |
| Ordered list | `1. item` |
