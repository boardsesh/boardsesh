'use client';

/**
 * Swagger UI Component
 *
 * Client-side wrapper for swagger-ui-react.
 * Loads the OpenAPI spec from /openapi.json (generated at build time).
 */

import { useEffect, useState } from 'react';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import styles from './docs.module.css';

// Typography destructuring removed - using MUI Typography directly

type LoadState = 'loading' | 'success' | 'not-found' | 'error';

export default function SwaggerUIComponent() {
  const [spec, setSpec] = useState<object | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    fetch('/openapi.json')
      .then((res) => {
        if (res.status === 404) {
          setLoadState('not-found');
          return null;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
      })
      .then((data) => {
        if (data) {
          setSpec(data);
          setLoadState('success');
        }
      })
      .catch((err) => {
        setLoadState('error');
        setErrorMessage(err.message);
      });
  }, []);

  if (loadState === 'loading') {
    return (
      <div className={styles.swaggerLoading}>
        <CircularProgress size={48} />
        <div className={styles.swaggerLoadingText}>
          <Typography variant="body2" component="span" color="text.secondary">
            {/* i18n-ignore-next-line -- technical reference, English only */}
            Loading API documentation...
          </Typography>
        </div>
      </div>
    );
  }

  if (loadState === 'not-found') {
    return (
      <MuiAlert severity="warning" className={styles.swaggerAlert}>
        {/* i18n-ignore-next-line -- technical reference, English only */}
        <AlertTitle>OpenAPI Specification Not Generated</AlertTitle>
        <div>
          <Typography variant="body1" component="p" className={styles.swaggerInstructions}>
            {/* i18n-ignore-next-line -- technical reference, English only */}
            The OpenAPI specification file has not been generated yet. This is expected during local development.
          </Typography>
          <Typography variant="body1" component="p" className={styles.swaggerInstructionsFinal}>
            {/* i18n-ignore-next-line -- technical reference, English only */}
            Run the following command to generate it:
          </Typography>
          <pre className={styles.swaggerCommandBlock}>vp run generate:openapi</pre>
          <Typography variant="body1" component="p" color="text.secondary" className={styles.swaggerNote}>
            {/* i18n-ignore-next-line -- technical reference, English only */}
            In production, this runs automatically during the build process.
          </Typography>
        </div>
      </MuiAlert>
    );
  }

  if (loadState === 'error') {
    return (
      <MuiAlert severity="error" className={styles.swaggerAlert}>
        {/* i18n-ignore-next-line -- technical reference, English only */}
        <AlertTitle>Failed to Load API Documentation</AlertTitle>
        {`Error: ${errorMessage}`}
      </MuiAlert>
    );
  }

  return <SwaggerUI spec={spec ?? undefined} />;
}
