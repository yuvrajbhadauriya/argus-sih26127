// 404 — any unknown path inside the dashboard shell.
import { Link, useLocation } from 'react-router-dom';
import { CompassIcon, MapIcon } from 'lucide-react';
import { Page } from '@/shared/layout/Page';
import { EmptyState } from '@/shared/ui/EmptyState';

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <Page>
      <EmptyState
        icon={<CompassIcon size={20} />}
        title="Page not found"
        description={
          <>
            There is no page at <span className="font-mono text-fg">{pathname}</span>. Check the address or go back to the command view.
          </>
        }
        action={
          <Link
            to="/"
            className="inline-flex h-8 touch:h-10 items-center gap-1.5 rounded-md border border-transparent bg-primary-solid px-3 text-xs font-semibold text-on-primary hover:bg-primary-solid-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <MapIcon size={14} strokeWidth={1.75} aria-hidden="true" />
            Back to Live Map
          </Link>
        }
      />
    </Page>
  );
}
