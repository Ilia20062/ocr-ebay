import { redirect } from 'next/navigation'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import Sidebar from '@/components/layout/Sidebar'
import UploadSessionProvider from '@/components/upload/UploadSessionProvider'
import UploadProgressWidget from '@/components/upload/UploadProgressWidget'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <UploadSessionProvider>
      <div className="flex h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
      <UploadProgressWidget />
    </UploadSessionProvider>
  )
}
