import Anthropic from '@anthropic-ai/sdk'

const PROMPT = `This is a straightened photo of a flipchart or whiteboard from a workshop.
Transcribe all the handwritten and printed words on it.

- Plain text only. No commentary, no headings you made up, no Markdown.
- Read top to bottom, left to right. One note, bubble or line of writing per line.
- Keep words that belong together (a bubble, a list) together, with a blank line between groups.
- Write lists as they appear, with a leading "- ".
- If a word is unreadable, write [?].`

// The key is the viewer's own, kept only in this browser and sent straight to the Claude API.
export async function transcribe(image: Blob, apiKey: string, onText: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const data = await blobToBase64(image)
  const stream = client.beta.messages.stream(
    {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    },
    { signal },
  )
  let text = ''
  stream.on('text', delta => {
    text += delta
    onText(text)
  })
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to read this image')
  return text.trim()
}

export function errorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'API key not accepted'
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited, try again shortly'
  if (e instanceof Anthropic.APIConnectionError) return 'Couldn’t reach the Claude API'
  if (e instanceof Anthropic.APIError) return e.message
  return e instanceof Error ? e.message : String(e)
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).split(',')[1])
    r.onerror = () => fail(r.error)
    r.readAsDataURL(blob)
  })
}
