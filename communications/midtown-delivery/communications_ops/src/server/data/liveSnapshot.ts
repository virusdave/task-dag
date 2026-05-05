import type { DashboardBlueprint, PerformanceDesign, StoreRecord } from '../../shared/types.js'

export interface TrackedSegmentDefinition {
  audienceState: 'Production' | 'Temporary'
  id: string
  note: string
  storeId: string
}

export interface TrackedCommunicationDefinition {
  currentActions: string[]
  id: string
  objective: string
  performanceStatus: string
  sourceNote: string
  storeId: string
}

export interface LocalCampaignDefinition {
  communicationIds: string[]
  id: string
  name: string
  note: string
  objective: string
}

export interface LocalExperimentArmDefinition {
  communicationId: string
  label: string
}

export interface LocalExperimentDefinition {
  campaignId: string | null
  control: LocalExperimentArmDefinition
  id: string
  name: string
  note: string
  objective: string
  primaryMetricKey: string
  primaryMetricLabel: string
  variants: LocalExperimentArmDefinition[]
}

export const patternSummary =
  'Pattern identified from helios: standalone React + Vite client, Fastify API, TypeScript worker, and a later Postgres-backed workflow layer.'

export const storeDefinitions: StoreRecord[] = [
  {
    id: 'midtown',
    dealerId: '210705',
    label: 'Freshly Baked NYC - Midtown',
    license: 'OCM-RETL-26-000488',
    ctaUrl: 'https://freshlybaked.nyc/stores/midtown/shop/menu?modal=locations',
  },
  {
    id: 'bronx',
    dealerId: '210249',
    label: 'Freshly Baked NYC - Bronx',
    license: 'OCM-CAURD-24-000137',
    ctaUrl: 'https://freshlybaked.nyc/stores/bronx/shop/menu?modal=locations',
  },
]

export const trackedSegmentDefinitions: TrackedSegmentDefinition[] = [
  {
    id: '7752',
    storeId: 'midtown',
    audienceState: 'Temporary',
    note: 'Temporary Midtown hold segment used while real delivery and campaign audiences are still being finalized.',
  },
  {
    id: '7906',
    storeId: 'midtown',
    audienceState: 'Production',
    note: 'Live Midtown delivery-zone segment currently attached to the Manhattan delivery communication.',
  },
  {
    id: '7950',
    storeId: 'midtown',
    audienceState: 'Production',
    note: 'Live western Queens delivery-zone segment currently attached to the Midtown delivery communication.',
  },
  {
    id: '7762',
    storeId: 'bronx',
    audienceState: 'Temporary',
    note: 'Temporary Bronx hold segment used on future 4/20 drafts pending final production audience selection.',
  },
  {
    id: '2773',
    storeId: 'bronx',
    audienceState: 'Production',
    note: 'Production Bronx audience for the Fordham student queue.',
  },
]

export const trackedCommunicationDefinitions: TrackedCommunicationDefinition[] = [
  {
    id: '1782',
    storeId: 'midtown',
    objective: 'Delivery-first Midtown communication for Manhattan and western Queens customers.',
    sourceNote:
      'Recovered in place from an earlier past-due state and now used as the tracked Midtown delivery mirror for this app.',
    currentActions: [
      'Replace temporary segment 7752 once the permanent delivery audience is finalized.',
      'Keep the parent visible while message triggers stay intentionally disabled until timing is approved.',
      'Use this event as the first live delivery workflow detail page in the app.',
    ],
    performanceStatus:
      'No BI snapshot stored in this app yet. Once wired, query MarketingStat by eventId 1782, then show channel breakdown and day trend.',
  },
  {
    id: '1803',
    storeId: 'midtown',
    objective: 'Sunday Midtown promo around Dr. Jekyll 2 for $50 and Ayrloom 4 for $20.',
    sourceNote:
      'Future Midtown 4/20 parent stays visible in Sweed while this app mirrors its live trigger state and saved body content.',
    currentActions: [
      'Swap off Test before any trigger-enable decision.',
      'Keep the saved CTA and footer rules intact while only timing and audience move.',
      'Use this event to validate the future-send schedule editor in the next app pass.',
    ],
    performanceStatus:
      'Pre-send only. After send, default dashboard should open on audience, delivered, unique open rate, click-through rate, opt-out rate, net sales, and gross margin.',
  },
  {
    id: '1804',
    storeId: 'midtown',
    objective: 'Midtown 4/20 day promo around MFNY and the $4.20 Dumbo Electric add-on.',
    sourceNote:
      'Future Midtown 4/20 day parent remains the live in-place target for any later operational edits rather than a draft to recreate.',
    currentActions: [
      'Keep the parent enabled and visible in Sweed.',
      'Replace Test with the real Midtown audience when it exists.',
      'Compare this event against 1803 and 1802 in the future experiment workspace instead of cloning a new wave.',
    ],
    performanceStatus:
      'Campaign readout should be a local rollup over child event snapshots; do not assume a native campaign Cube filter until a live probe confirms it.',
  },
  {
    id: '1806',
    storeId: 'bronx',
    objective: 'Historical Bronx 4/20 parent kept visible in a parked state for operator review.',
    sourceNote:
      'This parked-visible event is the archival reference for the workspace rule that historical parents should stay visible instead of disappearing as inactive.',
    currentActions: [
      'Keep this parked example in the app as the visible-parent archival reference.',
      'Use it to test the future historical-event guardrails before adding write actions.',
      'Do not collapse parked-visible state into Inactive in the UI.',
    ],
    performanceStatus:
      'When BI sync is added, historical parked parents still need event-level detail pages. Show original campaign performance separately from the later parked schedule metadata.',
  },
  {
    id: '1808',
    storeId: 'bronx',
    objective: 'Sunday Bronx promo around Booty Shake 14g for $45 and Golden Garden prerolls 3 for $30.',
    sourceNote:
      'Future Bronx 4/20 parent remains the live value-message reference with the corrected Bronx asset and footer rules.',
    currentActions: [
      'Swap off segment 7762 before go-live.',
      'Mirror future performance drilldowns by event, message, and segment once BI reads land.',
      'Use this event as one side of the Bronx value-message compare view.',
    ],
    performanceStatus:
      'Post-send dashboard should default to message-level comparison against 1809 and the parked 1806 reference without requiring a separate export.',
  },
  {
    id: '1812',
    storeId: 'bronx',
    objective: 'Fordham student referral communication on the live Bronx student segment.',
    sourceNote:
      'Part of the live Fordham queue and the cleanest production-segment example inside the current communications app mirror.',
    currentActions: [
      'Keep Fordham work on the existing event family 1811 through 1814.',
      'Expose production-segment context clearly so operators can distinguish it from hold segments.',
      'Use this event as the first A/B-ready candidate once versioned split segments exist.',
    ],
    performanceStatus:
      'Future experiment view should compare this student referral communication against other Fordham variants by delivery, unique open rate, click-through rate, opt-out rate, and net sales.',
  },
]

export const localCampaignDefinitions: LocalCampaignDefinition[] = [
  {
    id: 'midtown-420-weekend-wave',
    name: 'Midtown 4/20 Weekend Wave',
    objective:
      'Roll the Midtown 4/20 weekend sequence up from persisted child-event snapshots without assuming a native Sweed campaign analytics primitive.',
    note:
      'Groups the Sunday warm-up and 4/20-day closer that currently live as separate Midtown events in Sweed.',
    communicationIds: ['1803', '1804'],
  },
  {
    id: 'bronx-420-weekend-wave',
    name: 'Bronx 4/20 Weekend Wave',
    objective:
      'Keep the Bronx value-message family visible as one local campaign rollup even though Sweed stores it as separate event runs.',
    note:
      'Pairs the parked 4/17 reference with the later Bronx weekend value message so operators can read the family state together.',
    communicationIds: ['1806', '1808'],
  },
  {
    id: 'midtown-delivery-expansion',
    name: 'Midtown Delivery Expansion',
    objective:
      'Track the current Manhattan and western Queens delivery communication as its own local campaign until more delivery child runs are added.',
    note:
      'Starts as a single-run rollup so the app can keep delivery work in the same campaign layer as the promo families.',
    communicationIds: ['1782'],
  },
  {
    id: 'bronx-fordham-students',
    name: 'Bronx Fordham Students',
    objective:
      'Keep the live Fordham student queue isolated from the 4/20 family so future student variants have a dedicated campaign lane.',
    note:
      'Begins with the persisted production-segment referral communication and is ready to absorb later Fordham variants in place.',
    communicationIds: ['1812'],
  },
]

export const localExperimentDefinitions: LocalExperimentDefinition[] = [
  {
    id: 'midtown-420-weekend-compare',
    name: 'Midtown 4/20 Weekend Compare',
    campaignId: 'midtown-420-weekend-wave',
    objective:
      'Compare the Midtown Sunday warm-up against the 4/20-day closer from the persisted event snapshots.',
    note:
      'Directional comparison only: these are sequential runs, not a strict same-audience split test.',
    primaryMetricKey: 'net-sales',
    primaryMetricLabel: 'Net sales',
    control: {
      communicationId: '1803',
      label: 'Sunday warm-up',
    },
    variants: [
      {
        communicationId: '1804',
        label: '4/20-day closer',
      },
    ],
  },
  {
    id: 'bronx-value-message-compare',
    name: 'Bronx Value Message Compare',
    campaignId: 'bronx-420-weekend-wave',
    objective:
      'Compare the Bronx parked reference message against the later Bronx weekend value-message variant from persisted event snapshots.',
    note:
      'Directional comparison only until a true split audience exists for the Bronx value family.',
    primaryMetricKey: 'delivered',
    primaryMetricLabel: 'Delivered',
    control: {
      communicationId: '1806',
      label: 'Parked historical reference',
    },
    variants: [
      {
        communicationId: '1808',
        label: 'Sunday value variant',
      },
    ],
  },
]

export const dashboardArchitecture: DashboardBlueprint['architecture'] = [
  {
    label: 'Client',
    detail: 'React + Vite for fast list/detail navigation, previews, and dashboard drilldowns.',
  },
  {
    label: 'API',
    detail: 'Fastify owns dealer resets, live Sweed reads, and the normalized operator view models.',
  },
  {
    label: 'Worker',
    detail: 'Background jobs should next refresh BI snapshots, persist mirrors, and roll experiments up locally.',
  },
  {
    label: 'Data model',
    detail: 'Treat one Sweed marketing event as one communication run, then group runs locally into campaigns and experiments.',
  },
]

export const operatorFlow: DashboardBlueprint['operatorFlow'] = [
  'Start from the queue: what is scheduled, parked, production-ready, or still on a hold segment?',
  'Open a communication detail page, inspect the attached segments, and read live sample customers before touching timing.',
  'Review Email and Text in compact cards first, then open the full details panel only when needed.',
  'After send, stay in the same detail page for message-level performance and only escalate to campaign or experiment compare views when the operator needs synthesis.',
]

export const performanceDesign: PerformanceDesign = {
  layers: [
    {
      title: 'Portfolio dashboard',
      kpis: [
        'Audience',
        'Sent',
        'Delivered',
        'Unique open rate',
        'Click-through rate',
        'Opt-out rate',
        'Net sales',
        'Gross margin',
      ],
      drilldowns: ['Store', 'Lifecycle', 'Scheduled date window', 'Temporary vs production audience'],
      note: 'This is the fast “what needs attention now?” layer for operators.',
    },
    {
      title: 'Communication detail dashboard',
      kpis: ['Delivered', 'Opened', 'Unique opened', 'Clicks', 'Unique clicks', 'Average ticket', 'Total tickets'],
      drilldowns: ['notificationType', 'statDateTime day', 'footer totals', 'message preview sidecar'],
      note: 'The app should keep message preview and performance on the same page so operators do not lose context.',
    },
    {
      title: 'Campaign rollup',
      kpis: [
        'Aggregate audience',
        'Aggregate delivered',
        'Aggregate net sales',
        'Aggregate gross margin',
        'Rate recomputes from summed numerators',
      ],
      drilldowns: ['Child events', 'Send timeline', 'Store split'],
      note: 'Implement as a local rollup first; do not assume a native campaign-level Cube filter exists yet.',
    },
    {
      title: 'Experiment compare',
      kpis: ['Primary metric lift', 'Unique open rate delta', 'Click-through delta', 'Opt-out delta', 'Net sales delta'],
      drilldowns: ['Control vs variant', 'Audience split segment', 'Channel split', 'Daily trend'],
      note: 'Treat A/B tests as local experiment objects over multiple Sweed events, not as one overloaded event.',
    },
  ],
  cubeWorkflow: [
    'Call store.bi.auth.jwt from the normal RPC surface.',
    'Run cube/v1/load on MarketingStat for the main row query.',
    'Use store.bi.cube.totals for footer totals instead of recomputing them locally from the rowset.',
    'Use the annotation payload as schema metadata for labels, formatting, and semantics.',
    'Keep hourly breakdowns marked as inferred until a live probe confirms them.',
  ],
  abTesting: [
    'Create one local experiment record that groups multiple Sweed events.',
    'Use versioned static split segments instead of mutating one shared segment in place.',
    'Compare event snapshots locally so the app can show control vs variant even before a native campaign cube exists.',
    'Default the operator view to practical lift readouts before adding significance math.',
  ],
}

export const implementationPhases = [
  'Phase 1 - Replace the checked-in snapshot with live read-only Sweed mirrors for events, triggers, segments, and sample customers.',
  'Phase 2 - Add BI snapshot refresh jobs and event-level performance pages backed by store.bi.auth.jwt plus Cube queries.',
  'Phase 3 - Persist mirrored communications, segment previews, and analytics snapshots in Postgres so review history survives restarts.',
  'Phase 4 - Add safe schedule and trigger write paths with guardrails for past-due events, footer preservation, and parent-visible parked states.',
  'Phase 5 - Roll persisted child-event snapshots up into local campaign and experiment compare views instead of inventing a native Sweed campaign analytics contract.',
]
