import { startReactPages } from '@void/react/pages-client';
import { AdminNavigationFallback } from './AdminNavigationFallback.tsx';
import { configureCodeHighlighting } from './code-highlighting.ts';
import { adminComponents, adminLayoutTree, matchAdminRoute } from './pages.ts';
import './styles.css';

configureCodeHighlighting(() =>
  import('./code-highlighter.ts').then((module) => module.highlightCode),
);

void startReactPages({
  components: adminComponents,
  layoutTree: adminLayoutTree,
  routeMeta: {},
  matchRoute: matchAdminRoute,
  staticPageData: false,
  staticPageDataFastPath: false,
  viewTransitions: false,
  prefetchHoverDelay: 75,
  prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
  cacheVisitedPageData: true,
  navigationFallback: AdminNavigationFallback,
});
