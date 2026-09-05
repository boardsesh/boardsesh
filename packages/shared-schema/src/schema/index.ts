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
import { notificationsTypeDefs } from './notifications';
import { proposalsTypeDefs } from './proposals';
import { socialTypeDefs } from './social';
import { newClimbFeedTypeDefs } from './new-climb-feed';
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

export const typeDefs = [
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
  notificationsTypeDefs,
  proposalsTypeDefs,
  socialTypeDefs,
  newClimbFeedTypeDefs,
  betaLinksTypeDefs,
  integrationsTypeDefs,
  syncTypeDefs,
  locationSyncAdminTypeDefs,
  gymOwnerReassignTypeDefs,
  holdOutlineOverridesTypeDefs,
  queriesTypeDefs,
  mutationsTypeDefs,
  subscriptionsTypeDefs,
  eventsTypeDefs,
  controllerTypeDefs,
  feedbackTypeDefs,
  qaTypeDefs,
  boardPresenceTypeDefs,
];
