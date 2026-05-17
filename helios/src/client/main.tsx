import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import { router } from './app/router.js'
import { BuildStamp } from './components/BuildStamp.js'
import { PendingMigrationsBanner } from './components/PendingMigrationsBanner.js'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <>
    <BuildStamp />
    <PendingMigrationsBanner />
    <RouterProvider router={router} />
  </>,
)
