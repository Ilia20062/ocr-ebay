'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withContext } from '@/lib/log'

const STORAGE_KEY = 'ocr-crm:active-upload-session'

export type UploadStatus =
  | 'idle'
  | 'uploading'
  | 'grouping'
  | 'processing'
  | 'done'
  | 'error'

interface ServerSessionState {
  id: string
  status: 'uploading' | 'grouping' | 'processing' | 'review_ready' | 'done' | 'failed'
  total_images: number
  group_count: number
  error_message: string | null
}

interface PersistedSession {
  sessionId: string
  total: number
  uploaded: number
  status: UploadStatus
  groupCount: number
  startedAt: number
}

export interface UploadSessionState {
  sessionId: string | null
  status: UploadStatus
  total: number
  uploaded: number
  groupCount: number
  error: string | null
  /** Start a new upload — files chosen on the upload page. */
  startUpload: (files: File[], lotLabel?: string) => Promise<void>
  /** Manually clear local state — used after the user navigates to review. */
  dismiss: () => void
}

const Ctx = createContext<UploadSessionState | null>(null)

export function useUploadSession(): UploadSessionState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUploadSession must be used inside <UploadSessionProvider>')
  return v
}

export default function UploadSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [total, setTotal] = useState(0)
  const [uploaded, setUploaded] = useState(0)
  const [groupCount, setGroupCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Refs prevent the polling loop from going stale across renders / navigations.
  const pollingRef = useRef<{ sessionId: string; cancelled: boolean } | null>(null)
  const uploadingFilesRef = useRef<{ sessionId: string; cancelled: boolean } | null>(null)

  const persist = useCallback((next: Partial<PersistedSession> | null) => {
    if (typeof window === 'undefined') return
    if (next === null) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    const current = readPersisted()
    const merged: PersistedSession = {
      sessionId: next.sessionId ?? current?.sessionId ?? '',
      total: next.total ?? current?.total ?? 0,
      uploaded: next.uploaded ?? current?.uploaded ?? 0,
      status: next.status ?? current?.status ?? 'idle',
      groupCount: next.groupCount ?? current?.groupCount ?? 0,
      startedAt: next.startedAt ?? current?.startedAt ?? Date.now(),
    }
    if (!merged.sessionId) return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }, [])

  const dismiss = useCallback(() => {
    setSessionId(null)
    setStatus('idle')
    setTotal(0)
    setUploaded(0)
    setGroupCount(0)
    setError(null)
    // Mutate the handle objects in place — the running loops read
    // `handle.cancelled` from the SAME object they were created with, so a
    // spread-copy (the previous behaviour) would never reach them.
    if (pollingRef.current) pollingRef.current.cancelled = true
    if (uploadingFilesRef.current) uploadingFilesRef.current.cancelled = true
    persist(null)
  }, [persist])

  // Poll the server until the session reaches a terminal state. Returns an
  // explicit outcome so callers (both startUpload and the on-mount rehydrate
  // path) can decide what to do next — most importantly, whether to navigate
  // the user to /review. The previous version returned void and the caller
  // had to guess from a stale `status` closure + cancelled flag, which broke
  // for large uploads.
  type PollOutcome = 'ready' | 'failed' | 'cancelled'
  const pollUntilDone = useCallback(
    async (id: string): Promise<PollOutcome> => {
      // Cancel any prior poller.
      if (pollingRef.current) pollingRef.current.cancelled = true
      const handle = { sessionId: id, cancelled: false }
      pollingRef.current = handle

      const POLL_INTERVAL_MS = 2_000
      const pollLog = withContext({ scope: 'client.upload.poll', session_id: id })

      // No hard timeout: a large lot can spend an hour+ in OCR and the user
      // explicitly wants to be auto-navigated when it's done. A stale-tab
      // poll is harmless (just one GET every 2s) and the user can dismiss
      // the widget to stop it. The poll only ends when the server reports a
      // terminal state or the handle is cancelled by another startUpload /
      // dismiss().
      while (!handle.cancelled) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (handle.cancelled) return 'cancelled'
        try {
          const res = await fetch(`/api/upload-sessions/${id}`, { cache: 'no-store' })
          if (!res.ok) {
            pollLog.warn('poll non-ok response', { status_code: res.status })
            continue
          }
          const session = (await res.json()) as ServerSessionState
          if (session.status === 'grouping') {
            setStatus('grouping')
            persist({ status: 'grouping' })
          } else if (session.status === 'processing') {
            setStatus('processing')
            if (session.group_count) {
              setGroupCount(session.group_count)
              persist({ status: 'processing', groupCount: session.group_count })
            } else {
              persist({ status: 'processing' })
            }
          }
          if (session.status === 'review_ready') {
            setStatus('done')
            setGroupCount(session.group_count)
            persist({ status: 'done', groupCount: session.group_count })
            pollLog.info('session ready', { group_count: session.group_count })
            return 'ready'
          }
          if (session.status === 'failed') {
            setStatus('error')
            setError(session.error_message ?? 'Processing failed')
            persist(null)
            pollLog.error('session failed', { err: session.error_message })
            return 'failed'
          }
        } catch (err) {
          // Transient network — keep polling.
          pollLog.warn('poll transient error', { err })
        }
      }
      return 'cancelled'
    },
    [persist],
  )

  const startUpload = useCallback(
    async (files: File[], lotLabel?: string) => {
      const upLog = withContext({ scope: 'client.upload', total: files.length })
      const tStart = Date.now()
      // Reset state for a fresh upload.
      setStatus('uploading')
      setTotal(files.length)
      setUploaded(0)
      setGroupCount(0)
      setError(null)
      upLog.info('starting upload', { lot_label: lotLabel ?? null })

      try {
        // 1. Create session
        const sessionRes = await fetch('/api/upload-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lot_label: lotLabel || undefined }),
        })
        if (!sessionRes.ok) {
          throw new Error(`Failed to create upload session (HTTP ${sessionRes.status})`)
        }
        const session = (await sessionRes.json()) as { id: string }
        setSessionId(session.id)
        persist({
          sessionId: session.id,
          total: files.length,
          uploaded: 0,
          status: 'uploading',
          groupCount: 0,
          startedAt: Date.now(),
        })

        // 2. Upload files. Track cancellation so a "dismiss" stops the loop.
        if (uploadingFilesRef.current) uploadingFilesRef.current.cancelled = true
        const uploadHandle = { sessionId: session.id, cancelled: false }
        uploadingFilesRef.current = uploadHandle

        for (const file of files) {
          if (uploadHandle.cancelled) return
          const presignRes = await fetch(
            `/api/upload-sessions/${session.id}/images/presign`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: file.name,
                mime_type: file.type,
                file_size_bytes: file.size,
              }),
            },
          )
          if (!presignRes.ok) {
            const j = await presignRes.json().catch(() => ({}))
            throw new Error(
              `Failed to get upload URL for ${file.name}: ${j.error ?? `HTTP ${presignRes.status}`}`,
            )
          }
          const { upload_url, image_id } = (await presignRes.json()) as {
            upload_url: string
            image_id: string
          }

          const uploadRes = await fetch(upload_url, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type },
          })
          if (!uploadRes.ok) {
            throw new Error(
              `Upload failed for ${file.name}: HTTP ${uploadRes.status} ${uploadRes.statusText}`,
            )
          }

          await fetch(`/api/upload-sessions/${session.id}/images/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_id }),
          })

          setUploaded((prev) => {
            const next = prev + 1
            persist({ uploaded: next })
            return next
          })
        }

        upLog.info('all files uploaded', {
          session_id: session.id,
          dur_ms: Date.now() - tStart,
        })

        // 3. Trigger processing.
        setStatus('grouping')
        persist({ status: 'grouping' })
        const procRes = await fetch(`/api/upload-sessions/${session.id}/process`, {
          method: 'POST',
        })
        if (!procRes.ok) {
          const j = await procRes.json().catch(() => ({}))
          throw new Error(`Failed to start processing: ${j.error ?? `HTTP ${procRes.status}`}`)
        }

        // 4. Poll until done. Runs in this same provider, so navigating to /review
        //    or any other dashboard page does not interrupt it.
        const outcome = await pollUntilDone(session.id)

        // 5. Navigate ONLY on a real "ready" signal from the server. The prior
        //    version checked a stale closure-captured `status` + cancelled flag,
        //    which fired on timeout/failure too (taking the user to an empty
        //    review page) and missed real successes for large jobs that
        //    exceeded the old 20-minute poll cap.
        if (outcome === 'ready') {
          router.push(`/review?session=${session.id}`)
        }
      } catch (err) {
        const upLog = withContext({ scope: 'client.upload' })
        upLog.error('upload flow failed', { err, dur_ms: Date.now() - tStart })
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
        persist(null)
      }
    },
    // `status` was previously in deps to support the (broken) stale-closure
    // navigation check. Now that we navigate solely off the pollUntilDone
    // outcome, status is no longer read inside this callback — dropping it
    // keeps startUpload's identity stable while an upload is in flight.
    [persist, pollUntilDone, router],
  )

  // On mount: if there's a persisted in-flight session, hydrate state from it
  // and resume polling. Handles full-page reload mid-upload. The setState calls
  // here are intentional — this is the documented pattern for syncing client
  // state with localStorage on first mount, and the alternative (lazy state
  // initialiser) would cause an SSR/CSR hydration mismatch.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    const persisted = readPersisted()
    if (!persisted || !persisted.sessionId) return
    setSessionId(persisted.sessionId)
    setTotal(persisted.total)
    setUploaded(persisted.uploaded)
    setGroupCount(persisted.groupCount)
    setStatus(persisted.status)
    if (
      persisted.status === 'grouping' ||
      persisted.status === 'processing' ||
      persisted.status === 'uploading'
    ) {
      // Hydration path: resume polling. If the session reaches review_ready
      // while the user is on a non-review page, auto-navigate them — matches
      // the startUpload flow. Without this, reloading mid-process leaves the
      // user stuck staring at the progress widget forever.
      void pollUntilDone(persisted.sessionId).then((outcome) => {
        if (outcome === 'ready' && typeof window !== 'undefined') {
          if (!window.location.pathname.startsWith('/review')) {
            router.push(`/review?session=${persisted.sessionId}`)
          }
        }
      })
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const value: UploadSessionState = {
    sessionId,
    status,
    total,
    uploaded,
    groupCount,
    error,
    startUpload,
    dismiss,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function readPersisted(): PersistedSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PersistedSession
  } catch {
    return null
  }
}
