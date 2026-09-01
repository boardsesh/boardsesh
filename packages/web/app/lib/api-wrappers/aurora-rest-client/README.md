# Aurora Climbing API Client Documentation

This document provides comprehensive documentation for the TypeScript client that interacts with the Aurora Climbing API, based on the decompiled Android application code.

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Authentication](#authentication)
- [User Management](#user-management)
- [Social Features](#social-features)
- [Climbs](#climbs)
- [Ascents](#ascents)
- [Bids](#bids)
- [Circuits](#circuits)
- [Walls](#walls)
- [Tags](#tags)
- [Exhibits](#exhibits)
- [Search and Explore](#search-and-explore)
- [Notifications](#notifications)
- [Leaderboards](#leaderboards)
- [Pins and Gyms](#pins-and-gyms)
- [Data Synchronization](#data-synchronization)
- [Error Handling](#error-handling)

## Installation

To use the Aurora Climbing API client in your project:

```bash
pnpm add aurora-climbing-api
```

## Getting Started

First, import the client and create an instance:

```typescript
import AuroraClimbingClient from 'aurora-climbing-api';

// Initialize the client
const client = new AuroraClimbingClient({
  domain: 'api.auroraclimbing.com',
  apiVersion: 'v1', // Optional API version
});
```

## Authentication

### Sign Up

```typescript
const signUpDetails = {
  username: 'newuser',
  password: 'securepassword',
  emailAddress: 'user@example.com',
  mailingListOptIn: true,
};

try {
  const session = await client.signUp(signUpDetails);
  console.log('Signed up successfully:', session);
} catch (error) {
  console.error('Sign up failed:', error);
}
```

### Sign In

```typescript
try {
  const session = await client.signIn('username', 'password');
  console.log('Signed in successfully:', session);
  console.log('Token:', client.token); // Token is automatically set
} catch (error) {
  console.error('Sign in failed:', error);
}
```

### Sign Out

```typescript
try {
  await client.signOut();
  console.log('Signed out successfully');
} catch (error) {
  console.error('Sign out failed:', error);
}
```

## User Management

### Get User Profile

```typescript
try {
  const profile = await client.getUserProfile(userId);
  console.log('User profile:', profile);
} catch (error) {
  console.error('Failed to get profile:', error);
}
```

### Update Profile

```typescript
const profileDetails = {
  id: userId,
  name: 'John Doe',
  emailAddress: 'john@example.com',
  instagramUsername: 'johndoe_climbs',
  isPublic: true,
  // Optional avatar update
  avatarAction: {
    type: 'upload',
    data: imageBlob, // A Blob or File object
  },
  // Optional gym details
  gymDetails: {
    name: 'My Home Gym',
    address: '123 Main St',
    // Other gym properties...
  },
};

try {
  await client.saveProfile(profileDetails);
  console.log('Profile updated successfully');
} catch (error) {
  console.error('Failed to update profile:', error);
}
```

### Delete Account

```typescript
try {
  await client.deleteUser(userId, 'current-password');
  console.log('Account deleted successfully');
} catch (error) {
  console.error('Failed to delete account:', error);
}
```

## Social Features

### Get Followers

```typescript
try {
  const followers = await client.getFollowers(userId);
  console.log('Followers:', followers);
} catch (error) {
  console.error('Failed to get followers:', error);
}
```

### Get Following

```typescript
try {
  const following = await client.getFollowing(userId);
  console.log('Following:', following);
} catch (error) {
  console.error('Failed to get following:', error);
}
```

### Follow a User

```typescript
import { FollowState } from 'aurora-climbing-api';

try {
  const result = await client.saveFollow(
    targetUserId, // Who to follow
    currentUserId, // Your user ID
    FollowState.PENDING,
  );
  console.log('Follow request sent:', result);
} catch (error) {
  console.error('Failed to follow user:', error);
}
```

### Update Follow Status

```typescript
import { FollowState } from 'aurora-climbing-api';

// Accept a follow request
try {
  const result = await client.saveFollow(
    currentUserId, // Your user ID
    targetUserId, // User who requested to follow you
    FollowState.ACCEPTED,
  );
  console.log('Follow request accepted:', result);
} catch (error) {
  console.error('Failed to update follow status:', error);
}
```

## Climbs

### Save a Climb

```typescript
const climbDetails = {
  uuid: 'new-climb-uuid', // or existing UUID to update
  layoutId: 1,
  setterId: currentUserId,
  name: 'My New Climb',
  description: 'A fun climb with interesting moves',
  isDraft: false,
  framesCount: 1,
  framesPace: 0,
  placements: [], // Array of hold placements
  angle: 40, // Optional angle
};

try {
  const climb = await client.saveClimb(climbDetails);
  console.log('Climb saved:', climb);
} catch (error) {
  console.error('Failed to save climb:', error);
}
```

### Delete a Climb

```typescript
try {
  await client.deleteClimb('climb-uuid');
  console.log('Climb deleted successfully');
} catch (error) {
  console.error('Failed to delete climb:', error);
}
```

### Report a Climb

```typescript
const report = {
  userID: currentUserId,
  climbUUID: 'climb-uuid',
  message: 'This climb has inappropriate content',
};

try {
  await client.reportClimb(report);
  console.log('Climb reported successfully');
} catch (error) {
  console.error('Failed to report climb:', error);
}
```

## Ascents

### Save an Ascent

```typescript
const ascentDetails = {
  uuid: 'new-ascent-uuid', // or existing UUID to update
  userID: currentUserId,
  climbUUID: 'climb-uuid',
  angle: 40,
  isMirror: false,
  bidCount: 0,
  quality: 4, // Rating out of 5
  difficulty: 3, // Difficulty rating
  isBenchmark: false,
  comment: 'Great climb, crux is at the top',
  climbedAt: new Date().toISOString(),
};

try {
  const result = await client.saveAscent(ascentDetails);
  console.log('Ascent saved:', result);
} catch (error) {
  console.error('Failed to save ascent:', error);
}
```

### Delete an Ascent

```typescript
try {
  await client.deleteAscent('ascent-uuid');
  console.log('Ascent deleted successfully');
} catch (error) {
  console.error('Failed to delete ascent:', error);
}
```

### Get Logbook (User's Ascents)

```typescript
try {
  const logbook = await client.getLogbook(userId, ['climb', 'boulder']);
  console.log('Logbook entries:', logbook);
} catch (error) {
  console.error('Failed to get logbook:', error);
}
```

## Bids

### Save a Bid

```typescript
const bidDetails = {
  uuid: 'new-bid-uuid', // or existing UUID to update
  userID: currentUserId,
  climbUUID: 'climb-uuid',
  angle: 40,
  isMirror: false,
  bidCount: 1,
  comment: 'Almost got it, need more tries',
  climbedAt: new Date().toISOString(),
};

try {
  const result = await client.saveBid(bidDetails);
  console.log('Bid saved:', result);
} catch (error) {
  console.error('Failed to save bid:', error);
}
```

### Delete a Bid

```typescript
try {
  await client.deleteBid('bid-uuid');
  console.log('Bid deleted successfully');
} catch (error) {
  console.error('Failed to delete bid:', error);
}
```

## Circuits

### Save a Circuit

```typescript
const circuitDetails = {
  uuid: 'new-circuit-uuid', // or existing UUID to update
  userID: currentUserId,
  name: 'Endurance Training',
  description: 'A circuit designed for building endurance',
  color: '#FF5733',
  isPublic: true,
};

try {
  const result = await client.saveCircuit(circuitDetails);
  console.log('Circuit saved:', result);
} catch (error) {
  console.error('Failed to save circuit:', error);
}
```

### Delete a Circuit

```typescript
try {
  await client.deleteCircuit('circuit-uuid');
  console.log('Circuit deleted successfully');
} catch (error) {
  console.error('Failed to delete circuit:', error);
}
```

### Add Climbs to a Circuit

```typescript
try {
  const climbUUIDs = ['climb-uuid-1', 'climb-uuid-2', 'climb-uuid-3'];
  await client.saveCircuitClimbs('circuit-uuid', climbUUIDs);
  console.log('Climbs added to circuit successfully');
} catch (error) {
  console.error('Failed to add climbs to circuit:', error);
}
```

### Add Circuits to a Climb

```typescript
try {
  const circuitUUIDs = new Set(['circuit-uuid-1', 'circuit-uuid-2']);
  await client.saveClimbCircuits('climb-uuid', circuitUUIDs);
  console.log('Climb added to circuits successfully');
} catch (error) {
  console.error('Failed to add climb to circuits:', error);
}
```

## Walls

### Save a Wall

```typescript
const wallDetails = {
  uuid: 'new-wall-uuid', // or existing UUID to update
  userId: currentUserId,
  name: 'Home Wall',
  isAdjustable: true,
  angle: 30,
  layoutId: 1,
  productSizeId: 2,
  serialNumber: 'WALL123', // Optional
  holdSetIds: [1, 3, 5], // IDs of hold sets on the wall
};

try {
  const result = await client.saveWall(wallDetails);
  console.log('Wall saved:', result);
} catch (error) {
  console.error('Failed to save wall:', error);
}
```

### Delete a Wall

```typescript
try {
  await client.deleteWall('wall-uuid');
  console.log('Wall deleted successfully');
} catch (error) {
  console.error('Failed to delete wall:', error);
}
```

## Tags

### Save a Tag

```typescript
const tag = {
  entityUUID: 'climb-uuid', // UUID of the entity being tagged
  userID: currentUserId,
  name: 'Dynamic',
  isListed: true,
};

try {
  const result = await client.saveTag(tag);
  console.log('Tag saved:', result);
} catch (error) {
  console.error('Failed to save tag:', error);
}
```

## Exhibits

### Save an Exhibit

```typescript
try {
  await client.saveExhibit(
    currentUserId,
    'climb-uuid',
    'SERIAL123', // Optional serial number
  );
  console.log('Exhibit saved successfully');
} catch (error) {
  console.error('Failed to save exhibit:', error);
}
```

### Get Exhibits

```typescript
const filter = {
  serialNumber: 'SERIAL123',
  before: '2023-01-01T00:00:00Z', // Optional timestamp
  after: '2022-01-01T00:00:00Z', // Optional timestamp
};

try {
  const exhibits = await client.getExhibits(filter);
  console.log('Exhibits:', exhibits);
} catch (error) {
  console.error('Failed to get exhibits:', error);
}
```

## Search and Explore

### Search/Explore Content

```typescript
try {
  // Search with a query
  const results = await client.explore('crimpy problems');
  console.log('Search results:', results);

  // Search with a type filter
  const boulderResults = await client.explore('crimpy', 'boulder');
  console.log('Boulder results:', boulderResults);
} catch (error) {
  console.error('Search failed:', error);
}
```

## Notifications

### Get Notifications

```typescript
const filter = {
  types: ['user', 'climb', 'follow'],
  before: '2023-01-01T00:00:00Z', // Optional timestamp for pagination
};

try {
  const notifications = await client.getNotifications(filter);
  console.log('Notifications:', notifications);
} catch (error) {
  console.error('Failed to get notifications:', error);
}
```

## Leaderboards

### Get Leaderboards

```typescript
try {
  const leaderboards = await client.getLeaderboards();
  console.log('Available leaderboards:', leaderboards);
} catch (error) {
  console.error('Failed to get leaderboards:', error);
}
```

### Get Leaderboard Scores

```typescript
try {
  // Get first page of scores
  const scores = await client.getLeaderboardScores(leaderboardId);
  console.log('Leaderboard scores:', scores);

  // Get next page (pagination)
  const nextPageScores = await client.getLeaderboardScores(leaderboardId, 20);
  console.log('Next page scores:', nextPageScores);
} catch (error) {
  console.error('Failed to get leaderboard scores:', error);
}
```

## Pins and Gyms

### Get Pins (Gym Locations)

```typescript
try {
  const pins = await client.getPins();
  console.log('Gym pins:', pins);
} catch (error) {
  console.error('Failed to get pins:', error);
}
```

## Data Synchronization

### Sync Data with Server

```typescript
// Define shared sync tables with timestamps
const sharedSyncs = [
  { tableName: 'climbs', lastSynchronizedAt: '2023-01-01T00:00:00.000000' },
  { tableName: 'sets', lastSynchronizedAt: '2023-01-01T00:00:00.000000' },
];

// Define user sync tables with timestamps (only if authenticated)
const userSyncs = [
  { tableName: 'ascents', lastSynchronizedAt: '2023-01-01T00:00:00.000000' },
  { tableName: 'walls', lastSynchronizedAt: '2023-01-01T00:00:00.000000' },
];

try {
  // Sync both shared and user data
  const syncResult = await client.sync(sharedSyncs, userSyncs);
  console.log('Sync completed:', syncResult);

  // Or sync only shared data (no authentication required)
  const publicSyncResult = await client.sync(sharedSyncs);
  console.log('Public sync completed:', publicSyncResult);
} catch (error) {
  console.error('Sync failed:', error);
}
```

## Error Handling

The client throws meaningful errors that you can catch and handle:

```typescript
try {
  // Any API call
  const result = await client.someApiCall();
} catch (error) {
  if (error instanceof Error) {
    // Check for specific error messages
    if (error.message.includes('Authentication required')) {
      console.error('You need to sign in first');
    } else if (error.message.includes('Too many')) {
      console.error('Rate limit reached, try again later');
    } else {
      // Try to parse validation errors
      try {
        const validationErrors = JSON.parse(error.message);
        if (validationErrors.password) {
          console.error('Password error:', validationErrors.password[0]);
        }
      } catch {
        // Not a JSON error
        console.error('API error:', error.message);
      }
    }
  } else {
    console.error('Unknown error:', error);
  }
}
```

---

This documentation covers the full functionality of the Aurora Climbing API client. For additional details on specific endpoints or response formats, refer to the API source code and type definitions.
