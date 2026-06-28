import { SwitchRow } from '../SwitchRow';
import { useShowPlaylistTagsPreference } from '../../lib/show-playlist-tags-preference';

type PlaylistTagsSwitchRowProps = {
  label: string;
  description: string;
};

export function PlaylistTagsSwitchRow({ label, description }: PlaylistTagsSwitchRowProps) {
  const { enabled, setEnabled } = useShowPlaylistTagsPreference();

  return <SwitchRow label={label} description={description} value={enabled} onValueChange={setEnabled} />;
}
