import { adminBoardsTypeDefs } from './admin-boards';
import { privacyTypeDefs } from './privacy';
import { scalarTypeDefs } from './scalars';
import { climbTypeDefs } from './climb';
import { queueTypeDefs } from './queue';
import { sessionTypeDefs } from './session';
import { boardConfigTypeDefs } from './board-config';
import { userTypeDefs } from './user';
import { favoritesTypeDefs } from './favorites';
import { ticksTypeDefs } from './ticks';
import { activityFeedTypeDefs } from './activity-feed';
import { profileStatsTypeDefs } from './profile-stats';
import { playlistsTypeDefs } from './playlists';
import { boardEntitiesTypeDefs } from './board-entities';
import { gymsTypeDefs } from './gyms';
import { gymKiosksTypeDefs } from './gym-kiosks';
import { gymActivityStatsTypeDefs } from './gym-activity-stats';
import { setterSitemapTypeDefs } from './setter-sitemap';
import { notificationsTypeDefs } from './notifications';
import { proposalsTypeDefs } from './proposals';
import { socialTypeDefs } from './social';
import { newClimbFeedTypeDefs } from './new-climb-feed';
import { publicClimbRelatedContentTypeDefs } from './public-climb-related-content';
import { queriesTypeDefs } from './queries';
import { mutationsTypeDefs } from './mutations';
import { subscriptionsTypeDefs } from './subscriptions';
import { eventsTypeDefs } from './events';
import { boardPresenceTypeDefs } from './board-presence';
import { controllerTypeDefs } from './controller';
import { feedbackTypeDefs } from './feedback';
import { qaTypeDefs } from './qa';
import { betaLinksTypeDefs } from './beta-links';
import { integrationsTypeDefs } from './integrations';
import { syncTypeDefs } from './sync';
import { locationSyncAdminTypeDefs } from './location-sync-admin';
import { gymOwnerReassignTypeDefs } from './gym-owner-reassign';
import { holdOutlineOverridesTypeDefs } from './hold-outline-overrides';
import { sprayWallsTypeDefs, sprayWallResetTypeDefs, sprayWallModerationTypeDefs } from './spray-walls';
import { sprayDetectionTypeDefs } from './spray-detection';
import { sprayTrainingTypeDefs } from './spray-training';
import { sessionWorkoutsTypeDefs } from './session-workouts';
import { partnerSessionHistoryTypeDefs } from './partner-session-history';
import { userDataExportTypeDefs } from './user-data-export';
import { analyticsConsentTypeDefs } from './analytics-consent';
import { oauthClientsTypeDefs } from './oauth-clients';
import { partnerDeveloperEmailTypeDefs } from './partner-developer-email';
import { adminPartnerAppsTypeDefs } from './admin-partner-apps';
import { partnerWebhooksTypeDefs } from './partner-webhooks';
import { appWorkoutsTypeDefs } from './app-workouts';
import { connectedAppsTypeDefs } from './connected-apps';
import { appleAdsAttributionTypeDefs } from './apple-ads-attribution';
import { releaseContextTypeDefs } from './release-context';
import { cncPacksTypeDefs } from './cnc-packs';
import { offlineWriteDeliveryTypeDefs } from './offline-write-delivery';
import { directoryReportsTypeDefs } from './directory-reports';

export const typeDefs = [
  offlineWriteDeliveryTypeDefs,
  adminBoardsTypeDefs,
  releaseContextTypeDefs,
  appleAdsAttributionTypeDefs,
  privacyTypeDefs,
  scalarTypeDefs,
  climbTypeDefs,
  queueTypeDefs,
  sessionTypeDefs,
  boardConfigTypeDefs,
  userTypeDefs,
  favoritesTypeDefs,
  ticksTypeDefs,
  activityFeedTypeDefs,
  profileStatsTypeDefs,
  playlistsTypeDefs,
  boardEntitiesTypeDefs,
  gymsTypeDefs,
  gymKiosksTypeDefs,
  gymActivityStatsTypeDefs,
  setterSitemapTypeDefs,
  notificationsTypeDefs,
  proposalsTypeDefs,
  socialTypeDefs,
  newClimbFeedTypeDefs,
  publicClimbRelatedContentTypeDefs,
  betaLinksTypeDefs,
  integrationsTypeDefs,
  syncTypeDefs,
  locationSyncAdminTypeDefs,
  gymOwnerReassignTypeDefs,
  holdOutlineOverridesTypeDefs,
  sprayWallsTypeDefs,
  sprayDetectionTypeDefs,
  sprayTrainingTypeDefs,
  sessionWorkoutsTypeDefs,
  partnerSessionHistoryTypeDefs,
  sprayWallResetTypeDefs,
  sprayWallModerationTypeDefs,
  cncPacksTypeDefs,
  queriesTypeDefs,
  mutationsTypeDefs,
  subscriptionsTypeDefs,
  eventsTypeDefs,
  controllerTypeDefs,
  feedbackTypeDefs,
  qaTypeDefs,
  boardPresenceTypeDefs,
  userDataExportTypeDefs,
  analyticsConsentTypeDefs,
  oauthClientsTypeDefs,
  partnerDeveloperEmailTypeDefs,
  adminPartnerAppsTypeDefs,
  partnerWebhooksTypeDefs,
  appWorkoutsTypeDefs,
  connectedAppsTypeDefs,
  directoryReportsTypeDefs,
];
