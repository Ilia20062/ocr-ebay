'use client'

import { useCallback, useState, DragEvent, ChangeEvent } from 'react'

interface Props {
  onFiles: (files: File[]) => void
  disabled?: boolean
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff']
const MAX_SIZE_MB = 10

export default function DropZone({ onFiles, disabled }: Props) {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  const validate = useCallback((files: File[]): File[] => {
    setError('')
    const valid: File[] = []
    for (const f of files) {
      if (!ALLOWED_TYPES.includes(f.type)) {
        setError(`"${f.name}" is not a supported image type`)
        continue
      }
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        setError(`"${f.name}" exceeds ${MAX_SIZE_MB}MB limit`)
        continue
      }
      valid.push(f)
    }
    if (valid.length > 50) {
      setError('Maximum 50 images per batch')
      return valid.slice(0, 50)
    }
    return valid
  }, [])

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files)
    const valid = validate(files)
    if (valid.length > 0) onFiles(valid)
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    const valid = validate(files)
    if (valid.length > 0) onFiles(valid)
    e.target.value = ''
  }

  return (
    <div>
      <label
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center w-full h-52 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',')}
          className="hidden"
          onChange={onChange}
          disabled={disabled}
        />
        <span className="text-4xl mb-3">📷</span>
        <p className="text-sm font-medium text-gray-700">
          Drop images here or <span className="text-blue-600">browse</span>
        </p>
        <p className="text-xs text-gray-400 mt-1">JPEG, PNG, WEBP, TIFF — up to 10MB each, max 50 images</p>
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
