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
import { betaLinksTypeDefs } from './beta-links';
import { integrationsTypeDefs } from './integrations';

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
  notificationsTypeDefs,
  proposalsTypeDefs,
  socialTypeDefs,
  newClimbFeedTypeDefs,
  betaLinksTypeDefs,
  integrationsTypeDefs,
  queriesTypeDefs,
  mutationsTypeDefs,
  subscriptionsTypeDefs,
  eventsTypeDefs,
  controllerTypeDefs,
  feedbackTypeDefs,
  boardPresenceTypeDefs,
];
