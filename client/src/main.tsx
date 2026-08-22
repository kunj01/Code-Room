// import React from "react"
import "@/styles/global.css"
import ReactDOM from "react-dom/client"
import App from "./App.tsx"
import AppProvider from "./context/AppProvider.tsx"
import 'tldraw/tldraw.css'

ReactDOM.createRoot(document.getElementById("root")!).render(
    // <React.StrictMode>
    <AppProvider>
        <App />
    </AppProvider>,
    // </React.StrictMode>
)
