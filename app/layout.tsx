import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '@/components/shell';
export const metadata:Metadata={title:{default:'Resonance — Audio infrastructure for Discord',template:'%s · Resonance'},description:'Dua node Lavalink. Monitoring transparan. Infrastruktur audio untuk bot Discord.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="id"><body><Shell>{children}</Shell></body></html>;}
