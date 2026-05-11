// oxlint-disable-next-line no-restricted-imports -- raw postgres-js sql usage; migrate to drizzle
import { rowsFromResult, sql } from '@/app/lib/db/db';
import { NextResponse } from 'next/server';

export async function GET(req: Request, props: { params: Promise<{ board_name: string; layout_id: string }> }) {
  const params = await props.params;
  const { /*board_name,*/ layout_id } = params;

  try {
    const angles = rowsFromResult<{ angle: number }>(
      await sql`
      SELECT angle
      FROM kilter_products_angles
      JOIN layouts ON layouts.product_id = products_angles.product_id
      WHERE layouts.id = ${layout_id}
      ORDER BY angle ASC
    `,
    );
    return NextResponse.json(angles);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch angles' }, { status: 500 });
  }
}
