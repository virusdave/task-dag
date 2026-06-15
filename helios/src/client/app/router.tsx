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
import { WarehouseLocationsPage } from '../routes/catalog/WarehouseLocationsPage.js'
import { CatalogPage, catalogLoader } from '../routes/catalog/CatalogPage.js'
import { WhiteGlovePricingPage } from '../routes/catalog/whiteglove/WhiteGlovePricingPage.js'
import { PendingPurchasesPage, pendingPurchasesLoader } from '../routes/catalog/PendingPurchasesPage.js'
import {
  PurchaseSellThroughDetailPage,
  PurchaseSellThroughItemPage,
  PurchaseSellThroughListPage,
  purchaseSellThroughDetailLoader,
  purchaseSellThroughItemLoader,
  purchaseSellThroughListLoader,
} from '../routes/catalog/PurchaseSellThroughPages.js'
import { ReviewDetailsPage } from '../routes/catalog/ReviewDetailsPage.js'
import { StockRefreshPage } from '../routes/catalog/StockRefreshPage.js'
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
  ConfigSweedPurchasesIngestSchedulePage,
  configSweedPurchasesIngestScheduleLoader,
} from '../routes/config/ConfigSweedPurchasesIngestSchedulePage.js'
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
import { SweedSessionsPage, sweedSessionsLoader } from '../routes/config/SweedSessionsPage.js'
import { UsersPage, usersLoader } from '../routes/config/UsersPage.js'
import { GeoSegmentRulesPage, geoSegmentRulesLoader } from '../routes/config/GeoSegmentRulesPage.js'
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
import { SeoFaqListPage, seoFaqListLoader } from '../routes/seo/SeoFaqListPage.js'
import { SeoFaqEditorPage, seoFaqEditorLoader } from '../routes/seo/SeoFaqEditorPage.js'
import { SeoPostListPage, seoPostListLoader } from '../routes/seo/SeoPostListPage.js'
import { SeoPostEditorPage, seoPostEditorLoader } from '../routes/seo/SeoPostEditorPage.js'
import {
  SeoRecommendationsPage,
  seoRecommendationsLoader,
} from '../routes/seo/SeoRecommendationsPage.js'
import { SeoMetricsPage, seoMetricsLoader } from '../routes/seo/SeoMetricsPage.js'
import {
  SeoImageAssetListPage,
  seoImageAssetListLoader,
} from '../routes/seo/SeoImageAssetListPage.js'
import {
  SeoImageAssetEditorPage,
  seoImageAssetEditorLoader,
} from '../routes/seo/SeoImageAssetEditorPage.js'
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
import { CashierCheckInsPage } from '../routes/customers/CashierCheckInsPage.js'
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

// --- Nav redesign (virusdave/top-level#14) redirects ---
//
// The app landing and the quarantined pages keep their old URLs working
// as redirects so nothing breaks for bookmarks / muscle memory; the
// canonical nav surfaces them only in their new homes.
async function indexRedirectLoader() {
  // Landing moved off the (trashed) Dashboard to the Operations frontier.
  throw redirect('/tasks/frontier')
}

async function legacyDashboardLoader() {
  throw redirect('/trash/dashboard')
}

async function legacyCrmLoader() {
  throw redirect('/trash/crm')
}

async function trashIndexLoader() {
  throw redirect('/trash/dashboard')
}

// Category-root convenience redirects: typing a top-level category path
// lands on that category's canonical first page.
async function opsRootLoader() {
  throw redirect('/tasks/frontier')
}

async function customersRootLoader() {
  throw redirect('/admin/customers/check-ins')
}

async function reportsRootLoader() {
  throw redirect('/metrics')
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
        loader: indexRedirectLoader,
      },
      // Dashboard was quarantined under /trash (operator declared it
      // useless). Old URL redirects to its new home; the component is
      // rendered at /trash/dashboard below.
      {
        loader: legacyDashboardLoader,
        path: 'dashboard',
      },
      {
        element: <DashboardPage />,
        path: 'trash/dashboard',
      },
      {
        element: <ModuleLandingPage moduleCode="crm" />,
        path: 'trash/crm',
      },
      {
        loader: trashIndexLoader,
        path: 'trash',
      },
      // Category-root convenience redirects (nav redesign #14).
      {
        loader: opsRootLoader,
        path: 'ops',
      },
      {
        loader: customersRootLoader,
        path: 'customers',
      },
      {
        loader: reportsRootLoader,
        path: 'reports',
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
        element: <PurchaseSellThroughListPage />,
        loader: purchaseSellThroughListLoader,
        path: 'catalog/purchases',
      },
      {
        element: <PurchaseSellThroughDetailPage />,
        loader: purchaseSellThroughDetailLoader,
        path: 'catalog/purchases/:poId',
      },
      {
        element: <PurchaseSellThroughItemPage />,
        loader: purchaseSellThroughItemLoader,
        path: 'catalog/purchases/:poId/items/:lineId',
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
        element: <WarehouseLocationsPage />,
        path: 'catalog/warehouse-locations',
      },
      {
        // Canonical "refresh current inventory stock" page (nav redesign
        // #14). Reuses the existing workers.scheduling.stock run-now job.
        element: <StockRefreshPage />,
        path: 'catalog/inventory/stock-refresh',
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
        element: <SeoFaqListPage />,
        loader: seoFaqListLoader,
        path: 'seo/faq',
      },
      {
        element: <SeoFaqEditorPage />,
        loader: seoFaqEditorLoader,
        path: 'seo/faq/:faqSetId',
      },
      {
        element: <SeoPostListPage />,
        loader: seoPostListLoader,
        path: 'seo/posts',
      },
      {
        element: <SeoPostEditorPage />,
        loader: seoPostEditorLoader,
        path: 'seo/posts/:postId',
      },
      {
        element: <SeoImageAssetListPage />,
        loader: seoImageAssetListLoader,
        path: 'seo/images',
      },
      {
        element: <SeoImageAssetEditorPage />,
        loader: seoImageAssetEditorLoader,
        path: 'seo/images/:assetId',
      },
      {
        element: <SeoRecommendationsPage />,
        loader: seoRecommendationsLoader,
        path: 'seo/recommendations',
      },
      {
        element: <SeoMetricsPage />,
        loader: seoMetricsLoader,
        path: 'seo/metrics',
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
        // CRM is a planned placeholder with no current workflow; it was
        // moved to the Trash quarantine (/trash/crm) until it ships.
        loader: legacyCrmLoader,
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
      // Cashier-tablet privacy-redacted live display
      // (virusdave/top-level#12 / FreshlyBakedNYC/automation#40,
      // phase D1). NOT in the sidebar — the URL is meant to be
      // bookmarked on the at-counter tablet. Access is gated server-
      // side by `requireCashierDisplayUser` (admin OR the cashier-
      // display email allowlist).
      {
        element: <CashierCheckInsPage />,
        path: 'admin/customers/check-ins/cashier',
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
        element: <SweedSessionsPage />,
        loader: sweedSessionsLoader,
        path: 'config/sweed/sessions',
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
        element: <ConfigSweedPurchasesIngestSchedulePage />,
        loader: configSweedPurchasesIngestScheduleLoader,
        path: 'config/workers/scheduling/sweed-purchases-ingest',
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
        element: <GeoSegmentRulesPage />,
        loader: geoSegmentRulesLoader,
        path: 'config/marketing/geo-segment-rules',
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
