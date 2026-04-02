/**
 * AI Handler — uses Node's built-in https module.
 * No extra npm dependencies required.
 * Supports: Anthropic Claude, OpenAI GPT
 */
const https = require('https')

const SYSTEM_PROMPT = `You are an expert HTML, CSS, and JavaScript developer.
The user will provide an HTML document and a plain-English instruction.
Apply the instruction to the HTML and return ONLY the complete, modified HTML document.
Rules:
- Return raw HTML only — no markdown fences, no explanations, no commentary.
- Preserve all content that the instruction does not ask you to change.
- Keep inline scripts and styles unless told to remove them.
- If asked to make something mobile-responsive, add proper meta viewport and media queries.
- If asked to clean code, format it neatly with consistent indentation.`

function buildPrompt(html, instruction) {
  return `INSTRUCTION: ${instruction}\n\nHTML:\n${html}`
}

function stripCodeFences(text) {
  return text
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function callClaude({ html, instruction, apiKey, model }) {
  const effectiveModel = model || 'claude-sonnet-4-6'

  const { status, body } = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    {
      model: effectiveModel,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(html, instruction) }]
    }
  )

  if (body.error) throw new Error(`Claude API error: ${body.error.message}`)
  if (status !== 200) throw new Error(`Claude API returned status ${status}`)

  return stripCodeFences(body.content[0].text)
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI({ html, instruction, apiKey, model }) {
  const effectiveModel = model || 'gpt-4o'

  const { status, body } = await httpsPost(
    'api.openai.com',
    '/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    {
      model: effectiveModel,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(html, instruction) }
      ]
    }
  )

  if (body.error) throw new Error(`OpenAI API error: ${body.error.message}`)
  if (status !== 200) throw new Error(`OpenAI API returned status ${status}`)

  return stripCodeFences(body.choices[0].message.content)
}

// ─── Public ──────────────────────────────────────────────────────────────────

function callAI({ html, instruction, apiKey, provider, model }) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('No API key set. Open Settings (⚙) and enter your API key.')
  }
  if (!html || html.trim() === '') {
    throw new Error('The HTML editor is empty. Paste or open an HTML file first.')
  }
  if (!instruction || instruction.trim() === '') {
    throw new Error('No instruction provided. Tell the AI what to do.')
  }

  if (provider === 'openai') {
    return callOpenAI({ html, instruction, apiKey: apiKey.trim(), model })
  }
  return callClaude({ html, instruction, apiKey: apiKey.trim(), model })
}

module.exports = { callAI }
