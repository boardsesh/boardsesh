// PostHog flags events with an empty User-Agent as bots, and the RN SDK sends no
// UA it stores — so without this, real mobile traffic hides behind the bot filter.
// Static, non-bot constant (not `react-native` Platform) to keep the RN Flow
// barrel out of this module's graph, which would break the node-env test runner.
// Its own module (no platform fork) so both analytics-user-agent.ts and
// analytics-user-agent.web.ts can import it: a `./analytics-user-agent` import
// from inside the .web fork would resolve back to the fork itself under Metro web.
export const MOBILE_USER_AGENT = 'Boardsesh Mobile';
