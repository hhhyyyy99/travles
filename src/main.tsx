import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AccommodationProvider } from './hooks/useAccommodation'
import { RouteStatesProvider } from './hooks/useRouteStates'
import { AmapLiveProvider } from './hooks/useAmapLive'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccommodationProvider>
      <RouteStatesProvider>
        <AmapLiveProvider>
          <App />
        </AmapLiveProvider>
      </RouteStatesProvider>
    </AccommodationProvider>
  </StrictMode>,
)