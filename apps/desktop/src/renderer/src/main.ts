import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
// Element Plus (and its CSS) first, then our stylesheet, so `global.css` wins where they overlap.
import { installElementPlus } from './plugins/element-plus'
import { router } from './router'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
installElementPlus(app)
app.mount('#app')
