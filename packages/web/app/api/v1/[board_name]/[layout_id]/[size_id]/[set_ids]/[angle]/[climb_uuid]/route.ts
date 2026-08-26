// api/v1/[board_name]/[layout_id]/[size_id]/[set_ids]/[climb_uuid]
import { convertLitUpHoldsStringToMap } from '@/app/components/board-renderer/util';
import { getClimb } from '@/app/lib/data/queries';
import type { BoardRouteParametersWithUuid, ErrorResponse, FetchCurrentProblemResponse } from '@/app/lib/types';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { NextResponse } from 'next/server';

export async function GET(
  req: Request,
  props: { params: Promise<BoardRouteParametersWithUuid> },
): Promise<NextResponse<FetchCurrentProblemResponse | ErrorResponse>> {
  const params = await props.params;
  try {
    const parsedParams = await parseBoardRouteParamsWithSlugs(params);
    const result = await getClimb(parsedParams);

    if (!result) {
      return NextResponse.json({ error: `Failed to find problem ${params.climb_uuid}` }, { status: 404 });
    }

    // TODO: Multiframe support should remove the hardcoded [0]
    const litUpHoldsMap = convertLitUpHoldsStringToMap(result.frames, parsedParams.board_name)[0];
    // catalogAngle only exists to break canonical-angle ties on the server. Do
    // not grow the public v1 response with that internal implementation field.
    const { catalogAngle: _catalogAngle, ...publicClimb } = result;
    // Include both the rows and the total count in the response
    return NextResponse.json({ ...publicClimb, litUpHoldsMap });
  } catch (error) {
    console.error('Error fetching data:', error);
    return NextResponse.json({ error: 'Failed to fetch board details' }, { status: 500 });
  }
}
