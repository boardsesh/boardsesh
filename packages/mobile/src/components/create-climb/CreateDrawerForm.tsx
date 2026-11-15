import { usePartnerAppsEnabled } from '../../lib/graphql/hooks/use-connected-apps';
import { CreateDrawerFormView, type CreateDrawerFormViewProps } from './CreateDrawerFormView';
export function CreateDrawerForm(props: Omit<CreateDrawerFormViewProps, 'partnerAppsEnabled'>) {
  const partnerAppsEnabled = usePartnerAppsEnabled();
  return <CreateDrawerFormView {...props} partnerAppsEnabled={partnerAppsEnabled} />;
}
