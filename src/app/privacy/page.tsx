import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — OCR CRM',
  description: 'How OCR CRM collects, uses, and protects your data.',
}

const LAST_UPDATED = 'May 4, 2026'

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <article className="mx-auto max-w-3xl bg-white border border-gray-200 rounded-xl p-8 sm:p-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="prose prose-gray max-w-none space-y-6 text-gray-800 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-gray-900">1. Who We Are</h2>
            <p>
              OCR CRM (&quot;we&quot;, &quot;us&quot;, or &quot;the Service&quot;) is a tool that lets sellers upload product
              images, extract product codes via optical character recognition, and publish listings to eBay through
              eBay&rsquo;s official APIs. This policy explains what data we collect, why we collect it, and how it is
              stored and shared.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">2. Data We Collect</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Account data:</strong> email address and authentication credentials managed by Supabase Auth.
              </li>
              <li>
                <strong>Uploaded images:</strong> photos you upload for OCR processing, stored in Supabase Storage.
              </li>
              <li>
                <strong>Extracted text:</strong> product codes and other text recognized from your images.
              </li>
              <li>
                <strong>Listing data:</strong> titles, descriptions, prices, quantities, SKUs, and statuses for items
                you publish to eBay.
              </li>
              <li>
                <strong>eBay OAuth tokens:</strong> access and refresh tokens issued by eBay after you connect your
                account, encrypted at rest using AES-256 before being stored in our database.
              </li>
              <li>
                <strong>Operational logs:</strong> request timestamps, error messages, and retry events used to
                diagnose failures.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">3. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>To authenticate you and protect your account.</li>
              <li>To run OCR on the images you upload and present the results back to you.</li>
              <li>To create, publish, update, and end listings on eBay on your behalf.</li>
              <li>To refresh expired eBay tokens automatically so listings can continue to publish.</li>
              <li>To debug failures, retry failed operations, and improve service reliability.</li>
            </ul>
            <p className="mt-3">
              We do not sell your data. We do not use your data to train machine learning models. We do not share your
              data with advertisers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">4. Third-Party Services</h2>
            <p>To operate the Service we send relevant data to the following providers:</p>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>eBay</strong> &mdash; receives listing data, inventory data, and uses your OAuth tokens to
                authenticate API calls.{' '}
                <a
                  href="https://www.ebay.com/help/policies/member-behaviour-policies/user-privacy-notice-privacy-policy?id=4260"
                  className="text-blue-600 underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  eBay Privacy Notice
                </a>
                .
              </li>
              <li>
                <strong>Google Cloud Vision</strong> &mdash; receives image content for OCR text extraction.{' '}
                <a
                  href="https://cloud.google.com/terms/cloud-privacy-notice"
                  className="text-blue-600 underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Cloud Privacy Notice
                </a>
                .
              </li>
              <li>
                <strong>Supabase</strong> &mdash; hosts our database, authentication, and image storage.{' '}
                <a
                  href="https://supabase.com/privacy"
                  className="text-blue-600 underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Supabase Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Railway</strong> &mdash; hosts the application runtime.{' '}
                <a
                  href="https://railway.com/legal/privacy"
                  className="text-blue-600 underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Railway Privacy Policy
                </a>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">5. Data Storage and Security</h2>
            <p>
              Data is stored in Supabase (PostgreSQL and object storage) within the region selected for your project.
              eBay OAuth tokens are encrypted with AES-256 before being written to the database. All traffic between
              your browser, the Service, and third-party APIs is encrypted in transit using TLS.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">6. Data Retention</h2>
            <p>
              We retain your data for as long as your account is active. You may disconnect your eBay account at any
              time from the settings page, which deletes the stored OAuth tokens. To request full account deletion,
              contact us at the address below.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">7. Your Rights</h2>
            <p>
              Depending on your jurisdiction (including the EU/UK under GDPR and California under CCPA), you may have
              rights to access, correct, export, or delete the personal data we hold about you, and to withdraw
              consent. Contact us to exercise any of these rights.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">8. Cookies</h2>
            <p>
              We use strictly necessary cookies to keep you signed in and to protect the OAuth flow against CSRF
              attacks (the <code className="px-1 py-0.5 bg-gray-100 rounded">ebay_oauth_state</code> cookie). We do not
              use advertising or analytics cookies.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">9. Children</h2>
            <p>The Service is not directed at children under 13 and we do not knowingly collect their data.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">10. Changes to This Policy</h2>
            <p>
              We may update this policy from time to time. The &quot;Last updated&quot; date at the top of this page
              reflects the most recent revision. Material changes will be highlighted on the dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900">11. Contact</h2>
            <p>
              Questions about this policy or your data? Email{' '}
              <a href="mailto:chatgpt.penta@gmail.com" className="text-blue-600 underline">
                chatgpt.penta@gmail.com
              </a>
              .
            </p>
          </section>
        </div>

        <footer className="mt-10 pt-6 border-t border-gray-200 text-sm text-gray-500">
          <Link href="/" className="text-blue-600 hover:underline">
            &larr; Back to home
          </Link>
        </footer>
      </article>
    </main>
  )
}
