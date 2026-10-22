import { redirect } from 'next/navigation';

/** Routes & standard pay moved to /lanes. */
export default function PayRoutesPage() {
  redirect('/lanes');
}
