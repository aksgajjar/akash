/**
 * ai-handler.js — kept for optional cloud-API fallback.
 * Primary AI path is Ollama streaming via main.js IPC.
 * This module is only used if user explicitly selects Claude/OpenAI in settings.
 */
const https = require('https')

const SYSTEM = `You are a world-class senior HTML/CSS/JavaScript developer with 10+ years of experience.
You understand instructions in both English and Hindi.
Apply the instruction and return ONLY the complete updated HTML. No markdown, no explanations.`

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const str = JSON.stringify(body)
    const req = https.request(
      { hostname, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str), ...headers } },
      (res) => {
        let d = ''
        res.on('data', c => d += c)
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }) }
          catch { reject(new Error(`Bad JSON (${res.statusCode})`)) }
        })
      }
    )
    req.on('error', reject)
    req.write(str)
    req.end()
  })
}

function strip(text) {
  return text.replace(/^```(?:html)?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
}

async function callClaude({ html, instruction, apiKey, model }) {
  const { status, body } = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model: model || 'claude-sonnet-4-6', max_tokens: 8192, system: SYSTEM,
      messages: [{ role: 'user', content: `INSTRUCTION: ${instruction}\n\nHTML:\n${html}` }] }
  )
  if (body.error) throw new Error(body.error.message)
  if (status !== 200) throw new Error(`Claude API: HTTP ${status}`)
  return strip(body.content[0].text)
}

async function callOpenAI({ html, instruction, apiKey, model }) {
  const { status, body } = await httpsPost(
    'api.openai.com', '/v1/chat/completions',
    { Authorization: `Bearer ${apiKey}` },
    { model: model || 'gpt-4o', max_tokens: 8192,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `INSTRUCTION: ${instruction}\n\nHTML:\n${html}` }
      ] }
  )
  if (body.error) throw new Error(body.error.message)
  if (status !== 200) throw new Error(`OpenAI API: HTTP ${status}`)
  return strip(body.choices[0].message.content)
}

function callAI({ html, instruction, apiKey, provider, model }) {
  if (!apiKey?.trim()) throw new Error('API key missing')
  if (provider === 'openai') return callOpenAI({ html, instruction, apiKey: apiKey.trim(), model })
  return callClaude({ html, instruction, apiKey: apiKey.trim(), model })
}

module.exports = { callAI }
