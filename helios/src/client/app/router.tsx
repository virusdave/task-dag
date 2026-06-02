import { createBrowserRouter, redirect } from 'react-router-dom'

import { buildHeliosModulePath } from '../../shared/contracts/index.js'
import { getAppBasePath } from './paths.js'
import { AppShell } from '../components/AppShell.js'
import { loadSession } from './session.js'
import { AdsIngestPage } from '../routes/ads/AdsIngestPage.js'
import { CatalogBrandMappingPage, catalogBrandMappingLoader } from '../routes/catalog/CatalogBrandMappingPage.js'
import { CatalogEdibleThcClampPage, catalogEdibleThcClampLoader } from '../routes/catalog/CatalogEdibleThcClampPage.js'
import { CatalogHistoryPage, catalogHistoryLoader } from '../routes/catalog/CatalogHistoryPage.js'
import { CatalogMaintenanceIndexPage } from '../routes/catalog/CatalogMaintenanceIndexPage.js'
import { CatalogMarketDataPage, catalogMarketDataLoader } from '../routes/catalog/CatalogMarketDataPage.js'
import { CatalogMaintenancePage } from '../routes/catalog/CatalogMaintenancePage.js'
import { CatalogModulePage } from '../routes/catalog/CatalogModulePage.js'
import { CatalogNewEntryPage } from '../routes/catalog/CatalogNewEntryPage.js'
import { CatalogPage, catalogLoader } from '../routes/catalog/CatalogPage.js'
import { WhiteGlovePricingPage } from '../routes/catalog/whiteglove/WhiteGlovePricingPage.js'
import { PendingPurchasesPage, pendingPurchasesLoader } from '../routes/catalog/PendingPurchasesPage.js'
import { ReviewDetailsPage } from '../routes/catalog/ReviewDetailsPage.js'
import { ClusterProposalsPage } from '../routes/communications/ClusterProposalsPage.js'
import { CommunicationsLandingPage } from '../routes/communications/CommunicationsLandingPage.js'
import { PolicyReplacementReviewPage, policyReplacementReviewLoader } from '../routes/communications/PolicyReplacementReviewPage.js'
import { ConfigModulePage } from '../routes/config/ConfigModulePage.js'
import { ConfigCatalogSchedulePage, configCatalogScheduleLoader } from '../routes/config/ConfigCatalogSchedulePage.js'
import { ConfigLitalertsSchedulePage, configLitalertsScheduleLoader } from '../routes/config/ConfigLitalertsSchedulePage.js'
import { ConfigStockSchedulePage, configStockScheduleLoader } from '../routes/config/ConfigStockSchedulePage.js'
import {
  ConfigSweedOrdersIngestSchedulePage,
  configSweedOrdersIngestScheduleLoader,
} from '../routes/config/ConfigSweedOrdersIngestSchedulePage.js'
import {
  ConfigParsingLitalertsPage,
  configParsingLitalertsLoader,
} from '../routes/config/ConfigParsingLitalertsPage.js'
import {
  ConfigParsingLitalertsListingPage,
  configParsingLitalertsListingLoader,
} from '../routes/config/ConfigParsingLitalertsListingPage.js'
import {
  ConfigParsingPendingPurchasesPage,
  configParsingPendingPurchasesLoader,
} from '../routes/config/ConfigParsingPendingPurchasesPage.js'
import { ConfigWorkersPage } from '../routes/config/ConfigWorkersPage.js'
import { SweedAuthLogPage, sweedAuthLogLoader } from '../routes/config/SweedAuthLogPage.js'
import { UsersPage, usersLoader } from '../routes/config/UsersPage.js'
import { ConfigWorkersSchedulingPage, configWorkersSchedulingLoader } from '../routes/config/ConfigWorkersSchedulingPage.js'
import { DashboardPage } from '../routes/dashboard/DashboardPage.js'
import { GroupDetailPage, groupDetailLoader } from '../routes/groups/GroupDetailPage.js'
import { HistoryPage, historyLoader } from '../routes/history/HistoryPage.js'
import { JobDetailPage, jobDetailLoader } from '../routes/jobs/JobDetailPage.js'
import { JobsPage, jobsLoader } from '../routes/jobs/JobsPage.js'
import { LoginPage, loginLoader } from '../routes/login/LoginPage.js'
import {
  BrandDetailPage,
  DistributorDetailPage,
} from '../routes/metrics/MetricsEntityDetailPage.js'
import {
  BrandsIndexPage,
  DistributorsIndexPage,
} from '../routes/metrics/MetricsEntityIndexPage.js'
import { MetricsLayoutPage, metricsLoader } from '../routes/metrics/MetricsLayoutPage.js'
import { ModuleLandingPage } from '../routes/modules/ModuleLandingPage.js'
import { PricingGeneratePage, pricingGenerateLoader } from '../routes/pricing/PricingGeneratePage.js'
import { PricingReviewPage, pricingReviewLoader } from '../routes/pricing/PricingReviewPage.js'
import { PricingRunDetailPage, pricingRunDetailLoader } from '../routes/pricing/PricingRunDetailPage.js'
import { PricingRunsPage, pricingRunsLoader } from '../routes/pricing/PricingRunsPage.js'
import { ReviewPage, reviewLoader } from '../routes/review/ReviewPage.js'
import { SchedulingNewRunPage } from '../routes/scheduling/SchedulingNewRunPage.js'
import { SchedulingCandidateDetailPage, schedulingCandidateDetailLoader } from '../routes/scheduling/SchedulingCandidateDetailPage.js'
import { SchedulingRunDetailPage, schedulingRunDetailLoader } from '../routes/scheduling/SchedulingRunDetailPage.js'
import { SchedulingRunsPage, schedulingRunsLoader } from '../routes/scheduling/SchedulingRunsPage.js'
import { ScreensDevicesPage, screensDevicesLoader } from '../routes/screens/ScreensDevicesPage.js'
import { ScreensModulePage, screensModuleLoader } from '../routes/screens/ScreensModulePage.js'
import { TasksPage } from '../routes/tasks/TasksPage.js'
import { TaskFrontierPage } from '../routes/tasks/TaskFrontierPage.js'
import { EpicDagPage } from '../routes/tasks/EpicDagPage.js'
import { TaskDetailPage } from '../routes/tasks/TaskDetailPage.js'
import { UtilitiesLandingPage } from '../routes/utilities/UtilitiesLandingPage.js'
import { UtilitiesPromoNamesPage, utilitiesPromoNamesLoader } from '../routes/utilities/UtilitiesPromoNamesPage.js'
import { UtilitiesStaffPage, utilitiesStaffLoader } from '../routes/utilities/UtilitiesStaffPage.js'
import { VisitorScansPage, visitorScansLoader } from '../routes/visitors/VisitorScansPage.js'
import {
  CustomerVisitorDetailsPage,
  customerVisitorDetailsLoader,
} from '../routes/customers/CustomerVisitorDetailsPage.js'
import {
  CustomerMapPage,
  customerMapLoader,
} from '../routes/customers/CustomerMapPage.js'
import {
  CustomerReviewsListPage,
  customerReviewsListLoader,
} from '../routes/customerReviews/CustomerReviewsListPage.js'
import {
  CustomerReviewDetailPage,
  customerReviewDetailLoader,
} from '../routes/customerReviews/CustomerReviewDetailPage.js'
import {
  CustomerReviewsDrawingPage,
  customerReviewsDrawingLoader,
} from '../routes/customerReviews/CustomerReviewsDrawingPage.js'

async function rootLoader() {
  return loadSession()
}

async function legacyReviewLoader() {
  throw redirect(buildHeliosModulePath('catalog', 'review'))
}

async function legacyGroupDetailLoader({ params }: { params: Record<string, string | undefined> }) {
  throw redirect(buildHeliosModulePath('catalog', `groups/${params.catalogGroupId}`))
}

async function pricingIndexLoader() {
  throw redirect(buildHeliosModulePath('pricing', 'generate'))
}

async function legacyAdsLoader() {
  throw redirect(buildHeliosModulePath('communications', 'drive-ingest'))
}

export const router = createBrowserRouter([
  {
    element: <LoginPage />,
    loader: loginLoader,
    path: '/login',
  },
  {
    children: [
      {
        index: true,
        element: <DashboardPage />,
      },
      {
        element: <DashboardPage />,
        path: 'dashboard',
      },
      {
        loader: legacyAdsLoader,
        path: 'ads',
      },
      {
        element: <CatalogModulePage />,
        path: 'catalog',
      },
      {
        element: <GroupDetailPage />,
        loader: groupDetailLoader,
        path: 'catalog/groups/:catalogGroupId',
      },
      {
        element: <CatalogPage />,
        loader: catalogLoader,
        path: 'catalog/browser',
      },
      {
        element: <CatalogHistoryPage />,
        loader: catalogHistoryLoader,
        path: 'catalog/history',
      },
      {
        element: <ReviewPage />,
        loader: reviewLoader,
        path: 'catalog/review',
      },
      {
        element: <CatalogMarketDataPage />,
        loader: catalogMarketDataLoader,
        path: 'catalog/market-data',
      },
      {
        element: <CatalogBrandMappingPage />,
        loader: catalogBrandMappingLoader,
        path: 'catalog/brand-mapping',
      },
      {
        element: <PendingPurchasesPage />,
        loader: pendingPurchasesLoader,
        path: 'catalog/pending-purchases',
      },
      {
        element: <CatalogMaintenanceIndexPage />,
        path: 'catalog/maintenance',
      },
      {
        element: <CatalogMaintenancePage />,
        path: 'catalog/maintenance/site/:siteKey',
      },
      {
        element: <CatalogEdibleThcClampPage />,
        loader: catalogEdibleThcClampLoader,
        path: 'catalog/edible-thc-clamp',
      },
      {
        element: <CatalogNewEntryPage />,
        path: 'catalog/new-entry',
      },
      {
        element: <WhiteGlovePricingPage />,
        path: 'catalog/whiteglove/pricing',
      },
      {
        element: <ReviewDetailsPage />,
        path: 'catalog/review-details/:scopeKind/:scopeId',
      },
      {
        loader: legacyReviewLoader,
        path: 'review',
      },
      {
        loader: legacyGroupDetailLoader,
        path: 'groups/:catalogGroupId',
      },
      {
        element: <ScreensModulePage />,
        loader: screensModuleLoader,
        path: 'screens',
      },
      {
        element: <ScreensDevicesPage />,
        loader: screensDevicesLoader,
        path: 'screens/devices',
      },
      {
        element: <ModuleLandingPage moduleCode="crm" />,
        path: 'crm',
      },
      {
        element: <CommunicationsLandingPage />,
        path: 'communications',
      },
      {
        element: <AdsIngestPage />,
        path: 'communications/drive-ingest',
      },
      {
        element: <ClusterProposalsPage />,
        path: 'communications/cluster-proposals',
      },
      {
        element: <PolicyReplacementReviewPage />,
        loader: policyReplacementReviewLoader,
        path: 'communications/policy-replacements/:packetId',
      },
      {
        loader: pricingIndexLoader,
        path: 'pricing',
      },
      {
        element: <PricingReviewPage />,
        loader: pricingReviewLoader,
        path: 'pricing/review',
      },
      {
        element: <PricingGeneratePage />,
        loader: pricingGenerateLoader,
        path: 'pricing/generate',
      },
      {
        element: <PricingRunsPage />,
        loader: pricingRunsLoader,
        path: 'pricing/runs',
      },
      {
        element: <PricingRunDetailPage />,
        loader: pricingRunDetailLoader,
        path: 'pricing/runs/:proposalBatchId',
      },
      {
        element: <SchedulingRunsPage />,
        loader: schedulingRunsLoader,
        path: 'scheduling',
      },
      {
        element: <SchedulingNewRunPage />,
        path: 'scheduling/new',
      },
      {
        element: <SchedulingRunDetailPage />,
        loader: schedulingRunDetailLoader,
        path: 'scheduling/runs/:schedulingRunId',
      },
      {
        element: <SchedulingCandidateDetailPage />,
        loader: schedulingCandidateDetailLoader,
        path: 'scheduling/runs/:schedulingRunId/candidates/:candidateId',
      },
      {
        element: <UtilitiesLandingPage />,
        path: 'utilities',
      },
      {
        element: <UtilitiesStaffPage />,
        loader: utilitiesStaffLoader,
        path: 'utilities/staff',
      },
      {
        element: <UtilitiesPromoNamesPage />,
        loader: utilitiesPromoNamesLoader,
        path: 'utilities/promo-names',
      },
      {
        element: <CustomerReviewsListPage />,
        loader: customerReviewsListLoader,
        path: 'reviews',
      },
      {
        element: <CustomerReviewsDrawingPage />,
        loader: customerReviewsDrawingLoader,
        path: 'reviews/drawing',
      },
      {
        element: <CustomerReviewDetailPage />,
        loader: customerReviewDetailLoader,
        path: 'reviews/:submissionId',
      },
      {
        element: <TasksPage />,
        path: 'tasks',
      },
      {
        element: <TaskFrontierPage />,
        path: 'tasks/frontier',
      },
      {
        element: <EpicDagPage />,
        path: 'tasks/epic/:id',
      },
      {
        element: <TaskDetailPage />,
        path: 'tasks/task/:sha',
      },
      {
        element: <VisitorScansPage />,
        loader: visitorScansLoader,
        path: 'admin/visitors/scans',
      },
      // Canonical C1 route per parent design (#33).
      // Same component + loader; both URLs remain valid.
      {
        element: <VisitorScansPage />,
        loader: visitorScansLoader,
        path: 'admin/customers/check-ins',
      },
      {
        element: <CustomerVisitorDetailsPage />,
        loader: customerVisitorDetailsLoader,
        path: 'admin/customers/visitors/:scanId',
      },
      // C4: customer-origin map.
      {
        element: <CustomerMapPage />,
        loader: customerMapLoader,
        path: 'admin/customers/map',
      },
      {
        element: <ConfigModulePage />,
        path: 'config',
      },
      {
        element: <ConfigWorkersPage />,
        path: 'config/workers',
      },
      {
        element: <SweedAuthLogPage />,
        loader: sweedAuthLogLoader,
        path: 'config/sweed-auth-log',
      },
      {
        element: <ConfigWorkersSchedulingPage />,
        loader: configWorkersSchedulingLoader,
        path: 'config/workers/scheduling',
      },
      {
        element: <ConfigCatalogSchedulePage />,
        loader: configCatalogScheduleLoader,
        path: 'config/workers/scheduling/catalog',
      },
      {
        element: <ConfigLitalertsSchedulePage />,
        loader: configLitalertsScheduleLoader,
        path: 'config/workers/scheduling/litalerts',
      },
      {
        element: <ConfigStockSchedulePage />,
        loader: configStockScheduleLoader,
        path: 'config/workers/scheduling/stock',
      },
      {
        element: <ConfigSweedOrdersIngestSchedulePage />,
        loader: configSweedOrdersIngestScheduleLoader,
        path: 'config/workers/scheduling/sweed-orders-ingest',
      },
      {
        element: <ConfigParsingPendingPurchasesPage />,
        loader: configParsingPendingPurchasesLoader,
        path: 'config/parsing/pending-purchases',
      },
      {
        element: <ConfigParsingLitalertsPage />,
        loader: configParsingLitalertsLoader,
        path: 'config/parsing/litalerts',
      },
      {
        element: <ConfigParsingLitalertsListingPage />,
        loader: configParsingLitalertsListingLoader,
        path: 'config/parsing/litalerts/:competitor/listing/:fuzzyHash',
      },
      {
        element: <UsersPage />,
        loader: usersLoader,
        path: 'config/users',
      },
      {
        element: <JobsPage />,
        loader: jobsLoader,
        path: 'jobs',
      },
      {
        element: <JobDetailPage />,
        loader: jobDetailLoader,
        path: 'jobs/:jobId',
      },
      {
        element: <HistoryPage />,
        loader: historyLoader,
        path: 'history',
      },
      {
        element: <MetricsLayoutPage />,
        loader: metricsLoader,
        path: 'metrics',
      },
      {
        // Brand index — listed BEFORE the catch-all `:tabId` route so
        // the literal segment wins. The page itself is data-only
        // (hits /api/catalog-analytics/filters) so no loader.
        element: <BrandsIndexPage />,
        path: 'metrics/brands',
      },
      {
        // Canonical brand detail page. Renders one collapsible per
        // category where this brand has presence; each expand
        // lazy-loads an embedded catalog scatter scoped to the
        // brand within that category.
        element: <BrandDetailPage />,
        path: 'metrics/brands/:brandId',
      },
      {
        // Distributor index — same shape as Brands; pre-empts the
        // `:tabId` catch-all for the same reason.
        element: <DistributorsIndexPage />,
        path: 'metrics/distributors',
      },
      {
        // Canonical distributor detail page. The `:distributorName`
        // path segment carries the distributor's own name verbatim
        // (URL-encoded), since distributors are keyed by name on
        // sweed_package_current.
        element: <DistributorDetailPage />,
        path: 'metrics/distributors/:distributorName',
      },
      {
        // Per-tab dashboard route — same loader + page, the tab id is read
        // from useParams() inside MetricsLayoutPage. Tabs share the loaded
        // metric list and a per-tab toolbar config (agg / stack mode).
        //
        // Accepts both raw tab ids (e.g. `budtenders`, `inventory`) and
        // IA-level aliases registered in MetricsLayoutPage's
        // METRICS_TAB_ALIASES (e.g. `staff` → budtenders,
        // `reordering` → inventory).
        element: <MetricsLayoutPage />,
        loader: metricsLoader,
        path: 'metrics/:tabId',
      },
    ],
    element: <AppShell />,
    id: 'root',
    loader: rootLoader,
    path: '/',
  },
], {
  basename: getAppBasePath(),
})
