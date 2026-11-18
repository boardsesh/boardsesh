'use client';

import dynamic from 'next/dynamic';
import Box from '@mui/material/Box';
import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

/** No browser token persistence or request execution in a public documentation page. */
export default function PartnerApiReference({ loadingLabel, spec }: { loadingLabel: string; spec: object }) {
  return (
    <Box aria-label={loadingLabel}>
      <SwaggerUI spec={spec} supportedSubmitMethods={[]} persistAuthorization={false} />
    </Box>
  );
}
