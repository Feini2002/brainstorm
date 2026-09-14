import { redirect } from 'next/navigation';

import { DEFAULT_ROUTE } from '@/features/shared/navigation';

/** The root is a redirect only: there is no promotional landing page (T005-R01). */
export default function Home() {
  redirect(DEFAULT_ROUTE);
}
