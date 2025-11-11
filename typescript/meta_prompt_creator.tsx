import React, { useState } from 'react';

// Advanced markdown renderer for meta prompts
const MarkdownRenderer = ({ content }) => {
  const styles = `
    h1 { font-size: 20px; font-weight: 600; margin: 16px 0 8px 0; color: #ffffff; }
    h2 { font-size: 18px; font-weight: 600; margin: 14px 0 6px 0; color: #e2e8f0; }
    h3 { font-size: 16px; font-weight: 600; margin: 12px 0 5px 0; color: #cbd5e1; }
    h4 { font-size: 14px; font-weight: 600; margin: 10px 0 4px 0; color: #94a3b8; }
    strong { font-weight: 600; color: #ffffff; }
    em { font-style: italic; color: #e2e8f0; }
    code {
      background-color: #374151;
      padding: 3px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
      font-size: 12px;
      color: #fbbf24;
    }
    pre {
      background-color: #1f2937;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #374151;
      margin: 8px 0;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; color: #e5e7eb; }
    ul { margin: 6px 0; padding-left: 20px; }
    ol { margin: 6px 0; padding-left: 20px; }
    li { margin: 2px 0; color: #e5e7eb; line-height: 1.5; }
    ul li { list-style-type: disc; }
    ul ul li { list-style-type: circle; }
    ul ul ul li { list-style-type: square; }
    ol li { list-style-type: decimal; }
    p { margin: 8px 0; line-height: 1.6; color: #e5e7eb; }
    blockquote {
      border-left: 3px solid #6366f1;
      padding-left: 12px;
      margin: 8px 0;
      background-color: #1e293b;
      padding: 8px 12px;
      border-radius: 4px;
      font-style: italic;
      color: #cbd5e1;
    }
  `;

  const renderMarkdown = (text) => {
    let html = text;

    // Handle code blocks first
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Handle inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Handle headers
    html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');

    // Handle blockquotes
    html = html.replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>');

    // Handle bold and italic
    html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Process lists
    const lines = html.split('\n');
    const processedLines: string[] = [];
    const listStack: string[] = [];

    for (let line of lines) {
      const bulletMatch = line.match(/^(\s*)[-*+] (.+)$/);
      const numberMatch = line.match(/^(\s*)\d+\.\s(.+)$/);

      if (bulletMatch || numberMatch) {
        const match = bulletMatch || numberMatch;
        const indentLevel = Math.floor(match[1].length / 2);
        const content = match[2];
        const listType = bulletMatch ? 'ul' : 'ol';

        while (listStack.length > indentLevel + 1) {
          const closingTag = listStack.pop();
          processedLines.push(`</${closingTag}>`);
        }

        if (listStack.length === indentLevel) {
          processedLines.push(`<${listType}>`);
          listStack.push(listType);
        }

        processedLines.push(`<li>${content}</li>`);
      } else {
        while (listStack.length > 0) {
          const closingTag = listStack.pop();
          processedLines.push(`</${closingTag}>`);
        }

        if (line.trim() === '') {
          processedLines.push('<br />');
        } else if (!line.match(/^<[^>]+>/)) {
          if (line.trim()) {
            processedLines.push(`<p>${line}</p>`);
          }
        } else {
          processedLines.push(line);
        }
      }
    }

    while (listStack.length > 0) {
      const closingTag = listStack.pop();
      processedLines.push(`</${closingTag}>`);
    }

    return processedLines.join('');
  };

  return (
    <>
      <style>{styles}</style>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
    </>
  );
};

const MetaPromptGenerator = () => {
  const [rawIdeas, setRawIdeas] = useState('');
  const [metaPrompt, setMetaPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Sample examples for different types of prompting needs
  const examples = {
    ideas: `Content Creation Assistant
- Need help writing engaging blog posts about technology
- Should understand different writing styles (technical, casual, professional)
- Must include SEO optimization suggestions
- Should provide multiple headline options
- Need fact-checking capabilities
- Should adapt tone based on target audience`,

    concepts: `AI-Powered Code Review System
- Analyze code for bugs, security vulnerabilities, and performance issues
- Provide specific improvement suggestions with examples
- Support multiple programming languages (Python, JavaScript, Go, Rust)
- Explain complex concepts in simple terms
- Generate unit tests for uncovered code paths
- Follow industry best practices and coding standards
- Rate code quality on multiple dimensions`,

    requirements: `Customer Support Chatbot Enhancement
- Must handle complex multi-turn conversations
- Should escalate to human agents when appropriate
- Need to access customer history and previous interactions
- Must maintain empathetic and professional tone
- Should provide accurate product information
- Need to handle refunds, exchanges, and technical issues
- Must follow company policies and legal compliance
- Should learn from interactions to improve responses`
  };

  const loadExample = (type) => {
    setRawIdeas(examples[type]);
    setMetaPrompt('');
    setError('');
  };

  const handleGenerate = async () => {
    if (!rawIdeas.trim()) {
      setError('Please enter some ideas or requirements to generate a meta prompt.');
      return;
    }

    setIsLoading(true);
    setError('');
    setMetaPrompt('');

    try {
      const prompt = `You are an expert prompt engineer. Your task is to transform the user's raw ideas into an advanced, sophisticated meta prompt that follows best practices for AI interaction.

Create a meta prompt that includes:

1. **Clear Role Definition**: Define the AI's expertise and perspective
2. **Structured Instructions**: Break down the task into clear, actionable steps
3. **Context and Constraints**: Specify important parameters, limitations, and requirements
4. **Output Format**: Define exactly how the response should be structured
5. **Quality Guidelines**: Include criteria for what makes a good response
6. **Examples or Templates**: Provide concrete examples when helpful
7. **Error Handling**: Account for edge cases and clarifications

Structure your meta prompt with:
- A compelling system role/persona
- Clear task breakdown
- Specific formatting requirements
- Quality criteria
- Example structures when relevant

Make the prompt sophisticated, comprehensive, and production-ready. Use advanced prompting techniques like chain-of-thought, role-playing, structured output, and constraint specification.

Transform these raw ideas into a meta prompt:

${rawIdeas}

Please respond in English language and create a comprehensive, production-ready meta prompt.`;

      const response = await window.claude.complete(prompt);
      setMetaPrompt(response);
    } catch (err) {
      setError('An error occurred while generating the meta prompt. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setRawIdeas('');
    setMetaPrompt('');
    setError('');
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(metaPrompt);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      minHeight: '100vh',
      backgroundColor: '#111827',
      color: '#ffffff',
      padding: '24px'
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Header */}
        <header style={{ marginBottom: '32px' }}>
          <h1 style={{
            fontSize: '24px',
            fontWeight: '600',
            margin: '0 0 8px 0',
            color: '#ffffff'
          }}>
            Advanced Meta Prompt Generator
          </h1>
          <p style={{
            fontSize: '14px',
            color: '#9ca3af',
            margin: '0',
            lineHeight: '1.5'
          }}>
            Transform your raw ideas into sophisticated, structured prompts for AI systems
          </p>
        </header>

        {/* Main Content */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '24px',
          alignItems: 'start'
        }}>
          {/* Input Section */}
          <div style={{
            backgroundColor: '#1f2937',
            borderRadius: '12px',
            padding: '24px',
            border: '1px solid #374151'
          }}>
            <h2 style={{
              fontSize: '16px',
              fontWeight: '600',
              marginBottom: '16px',
              color: '#ffffff'
            }}>
              Raw ideas & requirements
            </h2>

            <div style={{ position: 'relative', marginBottom: '20px' }}>
              <textarea
                value={rawIdeas}
                onChange={(e) => setRawIdeas(e.target.value)}
                placeholder=" "
                style={{
                  width: '100%',
                  height: '280px',
                  padding: '16px',
                  borderRadius: '8px',
                  border: '1px solid #4b5563',
                  backgroundColor: '#374151',
                  fontSize: '13px',
                  color: '#ffffff',
                  resize: 'vertical',
                  lineHeight: '1.5',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  outline: 'none'
                }}
                onFocus={(e) => e.target.style.borderColor = '#6366f1'}
                onBlur={(e) => e.target.style.borderColor = '#4b5563'}
              />
              {!rawIdeas && (
                <div style={{
                  position: 'absolute',
                  top: '16px',
                  left: '16px',
                  pointerEvents: 'none',
                  color: '#9ca3af',
                  fontSize: '13px',
                  lineHeight: '1.5'
                }}>
                  Paste your{' '}
                  <button
                    onClick={() => loadExample('ideas')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#6366f1',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: '13px',
                      padding: '0',
                      pointerEvents: 'auto'
                    }}
                  >
                    ideas
                  </button>
                  ,{' '}
                  <button
                    onClick={() => loadExample('concepts')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#6366f1',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: '13px',
                      padding: '0',
                      pointerEvents: 'auto'
                    }}
                  >
                    concepts
                  </button>
                  , or{' '}
                  <button
                    onClick={() => loadExample('requirements')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#6366f1',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontSize: '13px',
                      padding: '0',
                      pointerEvents: 'auto'
                    }}
                  >
                    requirements
                  </button>
                  {' '}here...
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleGenerate}
                disabled={isLoading}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: '#6366f1',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.6 : 1,
                  transition: 'all 0.2s ease'
                }}
              >
                {isLoading ? 'Generating...' : 'Generate Meta Prompt'}
              </button>
              <button
                onClick={handleClear}
                style={{
                  padding: '10px 16px',
                  borderRadius: '8px',
                  border: '1px solid #4b5563',
                  backgroundColor: 'transparent',
                  color: '#9ca3af',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => {
                  e.target.style.backgroundColor = '#374151';
                  e.target.style.color = '#ffffff';
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = 'transparent';
                  e.target.style.color = '#9ca3af';
                }}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Output Section */}
          <div style={{
            backgroundColor: '#1f2937',
            borderRadius: '12px',
            padding: '24px',
            border: '1px solid #374151',
            position: 'relative'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px'
            }}>
              <h2 style={{
                fontSize: '16px',
                fontWeight: '600',
                color: '#ffffff',
                margin: '0'
              }}>
                Advanced Meta Prompt
              </h2>
              {metaPrompt && !isLoading && (
                <button
                  onClick={copyToClipboard}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: '1px solid #4b5563',
                    backgroundColor: 'transparent',
                    color: '#9ca3af',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#374151';
                    e.target.style.color = '#ffffff';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = 'transparent';
                    e.target.style.color = '#9ca3af';
                  }}
                >
                  Copy
                </button>
              )}
            </div>

            <div style={{
              minHeight: '350px',
              maxHeight: '500px',
              overflowY: 'auto',
              padding: '16px',
              borderRadius: '8px',
              backgroundColor: '#374151',
              border: '1px solid #4b5563',
              fontSize: '13px',
              lineHeight: '1.6',
              position: 'relative'
            }}>
              {metaPrompt && !isLoading && !error && (
                <div>
                  <MarkdownRenderer content={metaPrompt} />
                </div>
              )}
              {!metaPrompt && !isLoading && !error && (
                <div style={{
                  color: '#6b7280',
                  fontStyle: 'italic',
                  position: 'absolute',
                  top: '50%',
                  left: '16px',
                  right: '16px',
                  transform: 'translateY(-50%)',
                  textAlign: 'center'
                }}>
                  Your sophisticated meta prompt will appear here after you input your ideas and click "Generate Meta Prompt".
                </div>
              )}
              {error && (
                <div style={{
                  color: '#ef4444',
                  backgroundColor: '#1f2937',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid #7f1d1d',
                  fontSize: '12px'
                }}>
                  {error}
                </div>
              )}
              {isLoading && (
                <div style={{
                  color: '#6366f1',
                  textAlign: 'center',
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)'
                }}>
                  <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '12px' }}>
                    Crafting your advanced meta prompt...
                  </div>
                  <div style={{
                    width: '120px',
                    height: '2px',
                    background: '#374151',
                    borderRadius: '1px',
                    overflow: 'hidden',
                    position: 'relative'
                  }}>
                    <div style={{
                      width: '30px',
                      height: '100%',
                      background: '#6366f1',
                      borderRadius: '1px',
                      animation: 'loading 1.5s ease-in-out infinite'
                    }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes loading {
          0% { transform: translateX(-60px); }
          50% { transform: translateX(150px); }
          100% { transform: translateX(-60px); }
        }

        /* Custom scrollbar */
        ::-webkit-scrollbar {
          width: 6px;
        }

        ::-webkit-scrollbar-track {
          background: #374151;
          border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb {
          background: #4b5563;
          border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: #6b7280;
        }
      `}</style>
    </div>
  );
};

export default MetaPromptGenerator;
