#!/bin/bash
# Script to update resolver files to use ctx.db instead of imported singleton

set -e

FILES=(
	"packages/backend/src/graphql/resolvers/sessions/session-summary.ts"
	"packages/backend/src/graphql/resolvers/ticks/queries.ts"
	"packages/backend/src/graphql/resolvers/playlists/queries/discover.ts"
	"packages/backend/src/graphql/resolvers/playlists/queries/playlist-climbs.ts"
	"packages/backend/src/graphql/resolvers/playlists/queries/playlist-detail.ts"
	"packages/backend/src/graphql/resolvers/playlists/queries/user-playlists.ts"
	"packages/backend/src/graphql/resolvers/playlists/helpers/enrichment.ts"
	"packages/backend/src/graphql/resolvers/social/activity-feed.ts"
	"packages/backend/src/graphql/resolvers/social/boards.ts"
	"packages/backend/src/graphql/resolvers/social/comments.ts"
	"packages/backend/src/graphql/resolvers/social/community-settings.ts"
	"packages/backend/src/graphql/resolvers/social/entity-validation.ts"
	"packages/backend/src/graphql/resolvers/social/feed.ts"
	"packages/backend/src/graphql/resolvers/social/gyms.ts"
	"packages/backend/src/graphql/resolvers/social/helpers.ts"
	"packages/backend/src/graphql/resolvers/social/new-climb-subscriptions.ts"
	"packages/backend/src/graphql/resolvers/social/notifications.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/effects.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/enrichment.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/grade-analysis.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/mutations.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/queries.ts"
	"packages/backend/src/graphql/resolvers/social/proposals/setter-overrides.ts"
	"packages/backend/src/graphql/resolvers/social/roles.ts"
	"packages/backend/src/graphql/resolvers/social/search.ts"
	"packages/backend/src/graphql/resolvers/social/session-feed.ts"
	"packages/backend/src/graphql/resolvers/social/session-mutations.ts"
	"packages/backend/src/graphql/resolvers/social/setter-follows.ts"
	"packages/backend/src/graphql/resolvers/social/votes.ts"
)

for file in "${FILES[@]}"; do
	if [ ! -f "$file" ]; then
		echo "File not found: $file"
		continue
	fi

	echo "Processing $file..."

	# 1. Remove singleton db import
	sed -i '' "/import { db } from/d" "$file"

	# 2. Add RequestDbInstance import after first import
	sed -i '' "1s/^/import type { RequestDbInstance } from '@boardsesh\/db\/client';\n/" "$file"

	# 3. Add const db = ctx.db as RequestDbInstance; after ctx parameter declaration
	# This handles arrow functions and regular functions with ctx parameter
	sed -i '' 's/\(ctx: ConnectionContext\)\s*)\s*=>/\1) => {\n    const db = ctx.db as RequestDbInstance;/g' "$file"

	echo "  Done: $file"
done

echo ""
echo "Running typecheck to see remaining errors..."
cd /Users/marcodejongh/Projects/Github/boardsesh/analyse_history_sql
npx tsc --noEmit -p packages/backend/tsconfig.json 2>&1 | grep "error TS" | wc -l
