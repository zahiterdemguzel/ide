// The desktop explorer's file icons, on the phone. Both sides read the same
// mapping and the same SVG artwork — see src/renderer/shared/file-icons.js and
// the generated module below. The glyphs are self-colored (Simple Icons brand
// fills, Lucide strokes), so they need no tinting here.
import React from 'react';
import { SvgXml } from 'react-native-svg';
import { ICON_SVG, iconForFile, iconForFolder } from '../generated/desktop-assets';

type Props = { name: string; dir?: boolean; open?: boolean; size?: number };

export default function FileIcon({ name, dir = false, open = false, size = 18 }: Props) {
  const id = dir ? iconForFolder(open) : iconForFile(name);
  return <SvgXml xml={ICON_SVG[id] ?? ICON_SVG.file} width={size} height={size} />;
}
