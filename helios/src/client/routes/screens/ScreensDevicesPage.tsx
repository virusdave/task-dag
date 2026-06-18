import { Link, useLoaderData } from 'react-router-dom'

import {
  ScreensInventoryResponseSchema,
  type ScreensInventoryResponse,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyShortDateTime } from '../../app/nyTime.js'
import { Pill } from '../../components/Pill.js'

export async function screensDevicesLoader() {
  return loadJson('/api/screens/inventory', ScreensInventoryResponseSchema)
}

export function ScreensDevicesPage() {
  const data = useLoaderData() as ScreensInventoryResponse

  return (
    <section>
      <div className="page-header">
        <div>
          <p className="eyebrow">Screens Devices</p>
          <h2>Screen &amp; device inventory</h2>
          <p className="subtle-copy">
            Read-only view of every screen and its banners from the latest snapshot. To change banners, use the
            tools on the <Link to="/screens">Screens control room</Link>.
          </p>
        </div>
        <div className="inline-row wrap-row">
          <Link to="/screens">Control room</Link>
          <Link to="/jobs?module=screens">Screens jobs</Link>
          <Link to="/history?module=screens">Screens history</Link>
        </div>
      </div>

      <article className="mini-card" style={{ marginBottom: '1rem' }}>
        <header>
          <strong>Copy banners between screens</strong>
          <Pill tone="success">moved</Pill>
        </header>
        <p className="subtle-copy">
          Copying a banner onto a set of screens (including cross-site for image banners) now lives in one place:
          the Copy banners workflow on the control room. It replaces the old image-only sync that used to be on this
          page.
        </p>
        <div className="inline-row wrap-row">
          <Link className="primary-button like-button" to="/screens">Open Copy banners</Link>
        </div>
      </article>

      <div className="review-grid" style={{ marginBottom: '1rem' }}>
        <article className="mini-card">
          <header>
            <strong>Inventory source</strong>
            <Pill tone={data.inventorySource ? 'muted' : 'warning'}>{data.inventorySource ? 'artifact-backed' : 'missing'}</Pill>
          </header>
          {data.inventorySource ? (
            <>
              <p className="subtle-copy">
                {formatNyDateTime(data.inventorySource.capturedAt)} ET · {data.inventorySource.artifactKind.replaceAll('_', ' ')}
                {data.inventorySource.mode ? ` · ${data.inventorySource.mode.replace('_', ' ')}` : ''}
              </p>
              <p className="subtle-copy">{data.inventorySource.artifactPath}</p>
            </>
          ) : (
            <p className="subtle-copy">
              Queue a screens refresh from <Link to="/screens">the control room</Link> to capture a fresh device snapshot.
            </p>
          )}
        </article>

        <article className="mini-card">
          <header>
            <strong>Current snapshot</strong>
            <Pill tone="success">{`${data.summary.screenCount} screens`}</Pill>
          </header>
          <p className="subtle-copy">
            {data.summary.bannerCount} banners · {data.summary.imageBannerCount} image · {data.summary.zeroDurationBannerCount} zero-duration
          </p>
        </article>
      </div>

      {data.sites.length === 0 ? (
        <p className="empty-state">No screens inventory is available yet.</p>
      ) : (
        <div className="stacked-list">
          {data.sites.map((site) => (
            <article className="mini-card" key={site.dealerId}>
              <header>
                <strong>{site.dealerName}</strong>
                <Pill tone="muted">{`${site.screens.length} devices`}</Pill>
              </header>
              <div className="review-grid">
                {site.screens.map((screen) => (
                  <article className="review-card" key={`${site.dealerId}-${screen.screenId}`}>
                    <div className="review-card-header">
                      <div>
                        <strong>{screen.screenName}</strong>
                        <p className="subtle-copy">Screen #{screen.screenId}</p>
                      </div>
                      <div className="inline-row wrap-row">
                        <Pill tone={screen.screenEnabled === false ? 'warning' : 'success'}>
                          {screen.screenEnabled === false ? 'screen off' : 'screen on'}
                        </Pill>
                        <Pill tone="muted">{`${screen.banners.length} banners`}</Pill>
                      </div>
                    </div>

                    <div className="stacked-list">
                      {screen.banners.map((banner) => (
                        <div className="mini-card" key={banner.bannerId}>
                          <header>
                            <strong>{banner.bannerName}</strong>
                            <div className="inline-row wrap-row">
                              <Pill tone={banner.type.toLowerCase() === 'image' ? 'success' : 'muted'}>{banner.type}</Pill>
                              <Pill tone={banner.enabled ? 'success' : 'warning'}>{banner.enabled ? 'enabled' : 'disabled'}</Pill>
                            </div>
                          </header>
                          <p className="subtle-copy">
                            Banner #{banner.bannerId} · {formatDuration(banner.totalDuration)}
                            {banner.promoActionId ? ` · promo ${banner.promoActionId}` : ''}
                          </p>
                        </div>
                      ))}
                      {screen.banners.length === 0 ? <p className="empty-state">No banners on this screen.</p> : null}
                    </div>
                  </article>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

// Operator-facing times render in America/New_York (every store is NYC); see
// repo AGENTS.md.
function formatNyDateTime(iso: string): string {
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? 'unknown time' : nyShortDateTime(ms)
}

function formatDuration(duration: number | null): string {
  if (duration === null) {
    return 'duration unknown'
  }
  return `${duration}s`
}
