'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

import { LayoutDashboard, UploadCloud, History, ListChecks, Tags, Settings, LogOut } from 'lucide-react'

const nav = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/upload', label: 'Upload', icon: UploadCloud },
  { href: '/batches', label: 'Upload History', icon: History },
  { href: '/review', label: 'Review Queue', icon: ListChecks },
  { href: '/listings', label: 'Listings', icon: Tags },
  { href: '/settings/ebay', label: 'eBay Settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    const supabase = getSupabaseBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-5 py-5 border-b border-gray-200">
        <h1 className="font-bold text-gray-900 text-sm">OCR CRM</h1>
        <p className="text-xs text-gray-500 mt-0.5">eBay Automation</p>
      </div>
      <nav className="flex-1 p-3 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
              pathname === href
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
            }`}
          >
            <span className="text-gray-500 group-hover:text-current transition-colors">
              <Icon className="w-5 h-5" />
            </span>
            {label}
          </Link>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-200">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2.5 text-left px-3 py-2 text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors group"
        >
          <LogOut className="w-5 h-5 opacity-70 group-hover:opacity-100" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
