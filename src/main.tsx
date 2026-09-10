import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { RouteStatesProvider } from './hooks/useRouteStates'
import { AmapLiveProvider } from './hooks/useAmapLive'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouteStatesProvider>
      <AmapLiveProvider>
        <App />
      </AmapLiveProvider>
    </RouteStatesProvider>
  </StrictMode>,
)