import { guideMarkdownResponse } from '../guide-response';

export const dynamic = 'force-dynamic';
export function GET() { return guideMarkdownResponse('changelog'); }
