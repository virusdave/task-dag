import { createBrowserRouter, redirect } from 'react-router-dom'

import { buildHeliosModulePath } from '../../shared/contracts/index.js'
import { getAppBasePath } from './paths.js'
import { AppShell } from '../components/AppShell.js'
import { loadSession } from './session.js'
import { AdsIngestPage } from '../routes/ads/AdsIngestPage.js'
import { CatalogHistoryPage, catalogHistoryLoader } from '../routes/catalog/CatalogHistoryPage.js'
import { CatalogMaintenanceIndexPage } from '../routes/catalog/CatalogMaintenanceIndexPage.js'
import { CatalogMaintenancePage } from '../routes/catalog/CatalogMaintenancePage.js'
import { CatalogModulePage } from '../routes/catalog/CatalogModulePage.js'
import { CatalogNewEntryPage } from '../routes/catalog/CatalogNewEntryPage.js'
import { CatalogPage, catalogLoader } from '../routes/catalog/CatalogPage.js'
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
        element: <CatalogNewEntryPage />,
        path: 'catalog/new-entry',
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
        element: <ModuleLandingPage moduleCode="utilities" />,
        path: 'utilities',
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
        element: <ConfigParsingPendingPurchasesPage />,
        loader: configParsingPendingPurchasesLoader,
        path: 'config/parsing/pending-purchases',
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
    ],
    element: <AppShell />,
    id: 'root',
    loader: rootLoader,
    path: '/',
  },
], {
  basename: getAppBasePath(),
})
