import Image from 'next/image';
import Box from '@mui/material/Box';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import styles from './brand-lockup.module.css';

/** The genuine product mark and wordmark, shared by the site's two landmarks. */
export default function BrandLockup({ eager = false }: { eager?: boolean }) {
  return (
    <Box component="span" className={styles.lockup}>
      <Image
        src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.png')}
        alt=""
        width={40}
        height={40}
        loading={eager ? 'eager' : 'lazy'}
        className={styles.mark}
      />
      <Box component="span" className={styles.wordmark}>
        {/* i18n-ignore-next-line — brand name, never translated */}
        Boardsesh
      </Box>
    </Box>
  );
}
