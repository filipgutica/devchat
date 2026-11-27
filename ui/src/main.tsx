// The design system's load order for a React app on ui-sdk (DESIGN.md "ui-sdk"): the layer order, then
// tokens.css and ui-sdk.css, then the unlayered badge, alert, and conversation styles. No ui-sdk web.css,
// and no agent bridge: release 1 uses no ui-sdk core behaviours (§12).
import './layers.css'
import '@filipgutica/design-system/tokens.css'
import '@filipgutica/design-system/fonts.css'
import '@filipgutica/design-system/ui-sdk.css'
import '@filipgutica/design-system/language/feedback.css'
import '@filipgutica/design-system/language/conversation.css'
import './app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
