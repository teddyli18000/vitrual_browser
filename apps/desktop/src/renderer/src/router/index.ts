import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import AboutView from '../views/AboutView.vue'
import GroupsView from '../views/GroupsView.vue'
import ProfilesView from '../views/ProfilesView.vue'
import SettingsView from '../views/SettingsView.vue'
import SyncView from '../views/SyncView.vue'

/** Hash history: the production renderer is loaded from `file://`. */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/profiles' },
  { path: '/profiles', name: 'profiles', component: ProfilesView },
  { path: '/sync', name: 'sync', component: SyncView },
  { path: '/groups', name: 'groups', component: GroupsView },
  { path: '/settings', name: 'settings', component: SettingsView },
  { path: '/about', name: 'about', component: AboutView },
  { path: '/:pathMatch(.*)*', redirect: '/profiles' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
