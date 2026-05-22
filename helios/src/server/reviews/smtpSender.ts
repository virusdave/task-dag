// Customer-Sentiment Capture (issue #13, A3 phase) — minimal SMTP sender.
//
// Two modes:
//
//   1. Mailbox not provisioned yet (REVIEWS_SMTP_HOST unset):
//      every send call returns status='queued' with sentAt=null and
//      no error. review_emails rows land as "queued" — the operator
//      /reviews page can still surface the would-be send without any
//      actual delivery happening. This is the default during the
//      cross-repo wait on nixos-sbc shipping reviews@freshlybaked.us.
//
//   2. Mailbox provisioned (REVIEWS_SMTP_HOST set):
//      open a plain-TCP SMTP connection and run the bare minimum
//      EHLO/MAIL FROM/RCPT TO/DATA/./QUIT exchange. No STARTTLS, no
//      AUTH — wire those in when the real relay endpoint requires
//      them. Any failure (transport, refused, 4xx, 5xx, timeout)
//      collapses to status='failed' with sentAt=null and the error
//      message captured for the review_emails.send_error column.
//
// We deliberately avoid taking a dependency on nodemailer or similar
// for two reasons: (a) keep helios's npm tree small and (b) the
// eventual relay is likely to be a local trusted hop, so the minimal
// protocol is sufficient. When that changes, swap this sender for a
// nodemailer-backed implementation behind the same SendEmailResult
// contract.

import { createConnection, type Socket } from 'node:net'

import { getServerEnv } from '../config/env.js'

export type SendEmailStatus = 'queued' | 'sent' | 'failed' | 'skipped'

export interface SendEmailResult {
  status: SendEmailStatus
  sentAt: Date | null
  error: string | null
}

export interface SendEmailInput {
  to: string
  from: string
  subject: string
  text: string
  html: string
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const env = getServerEnv()
  if (env.reviewsSmtpHost === null) {
    return { status: 'queued', sentAt: null, error: null }
  }
  try {
    await smtpDeliver({
      ...input,
      host: env.reviewsSmtpHost,
      port: env.reviewsSmtpPort,
      timeoutMs: env.reviewsSmtpTimeoutMs,
    })
    return { status: 'sent', sentAt: new Date(), error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failed', sentAt: null, error: message }
  }
}

interface SmtpDeliverInput extends SendEmailInput {
  host: string
  port: number
  timeoutMs: number
}

// Tiny SMTP client: connect, read 220 banner, EHLO, MAIL FROM,
// RCPT TO, DATA, body, ., QUIT. Throws on any unexpected response.
async function smtpDeliver(input: SmtpDeliverInput): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const socket: Socket = createConnection({ host: input.host, port: input.port })
    socket.setEncoding('utf8')
    socket.setTimeout(input.timeoutMs)

    type Step =
      | 'banner'
      | 'ehlo'
      | 'mail-from'
      | 'rcpt-to'
      | 'data'
      | 'body'
      | 'quit'
      | 'done'
    let step: Step = 'banner'
    let buffer = ''
    let finished = false

    const finishOk = () => {
      if (finished) return
      finished = true
      socket.end()
      resolvePromise()
    }
    const finishErr = (msg: string) => {
      if (finished) return
      finished = true
      socket.destroy()
      rejectPromise(new Error(msg))
    }

    const send = (line: string) => {
      socket.write(`${line}\r\n`)
    }

    const expect = (line: string, prefix: string): boolean => {
      // SMTP multi-line replies use "xxx-..." for intermediate and
      // "xxx ..." for the final line; we only act on the final line.
      return line.startsWith(prefix)
    }

    socket.on('connect', () => {
      // Wait for banner.
    })

    socket.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Process complete lines.
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        // Skip intermediate multi-line continuation rows.
        if (/^\d{3}-/.test(line)) continue
        handleLine(line)
        if (finished) return
      }
    })

    const handleLine = (line: string) => {
      switch (step) {
        case 'banner':
          if (!expect(line, '220')) return finishErr(`SMTP banner unexpected: ${line}`)
          step = 'ehlo'
          send(`EHLO helios.local`)
          return
        case 'ehlo':
          if (!expect(line, '250')) return finishErr(`SMTP EHLO rejected: ${line}`)
          step = 'mail-from'
          send(`MAIL FROM:<${input.from}>`)
          return
        case 'mail-from':
          if (!expect(line, '250')) return finishErr(`SMTP MAIL FROM rejected: ${line}`)
          step = 'rcpt-to'
          send(`RCPT TO:<${input.to}>`)
          return
        case 'rcpt-to':
          if (!expect(line, '250')) return finishErr(`SMTP RCPT TO rejected: ${line}`)
          step = 'data'
          send('DATA')
          return
        case 'data':
          if (!expect(line, '354')) return finishErr(`SMTP DATA rejected: ${line}`)
          step = 'body'
          writeBody()
          return
        case 'body':
          if (!expect(line, '250')) return finishErr(`SMTP DATA body rejected: ${line}`)
          step = 'quit'
          send('QUIT')
          return
        case 'quit':
          // Whatever the server says, we are done. Mark ok.
          step = 'done'
          finishOk()
          return
        case 'done':
          return
      }
    }

    const writeBody = () => {
      const headers = [
        `From: ${input.from}`,
        `To: ${input.to}`,
        `Subject: ${encodeHeader(input.subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${MIME_BOUNDARY}"`,
      ].join('\r\n')
      const textPart = [
        `--${MIME_BOUNDARY}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        dotStuff(input.text),
      ].join('\r\n')
      const htmlPart = [
        `--${MIME_BOUNDARY}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        dotStuff(input.html),
      ].join('\r\n')
      const closing = `--${MIME_BOUNDARY}--`
      const body = `${headers}\r\n\r\n${textPart}\r\n${htmlPart}\r\n${closing}\r\n.\r\n`
      socket.write(body)
    }

    socket.on('error', (err: Error) => finishErr(err.message))
    socket.on('timeout', () => finishErr(`SMTP timeout after ${input.timeoutMs}ms`))
    socket.on('close', () => {
      if (!finished) finishErr('SMTP connection closed unexpectedly')
    })
  })
}

const MIME_BOUNDARY = 'helios-reviews-boundary-89b4f1'

// Per RFC 5321: a line consisting of only '.' is the end-of-data
// marker. Any line in the body that begins with '.' must be prefixed
// with an additional '.' so the server strips it back to a single
// '.' on receipt.
function dotStuff(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

// RFC 2047 encoded-word for non-ASCII subjects. Cheap UTF-8 / base64
// envelope so accented characters or emoji don't break the wire
// format.
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}
