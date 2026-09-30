import { notFound } from 'next/navigation';
import { Overview } from '@/components/overview';
import { Account,AuthForm } from '@/components/account';
import { Documentation,Policy,Changelog } from '@/components/docs';
export default async function Page({params}:{params:Promise<{section:string}>}){const{section}=await params;
 if(['dashboard','nodes','statistics','uptime'].includes(section))return <Overview mode={section==='dashboard'?'overview':section}/>;
 if(section==='login'||section==='register')return <AuthForm register={section==='register'}/>;
 if(section==='account'||section==='admin')return <Account admin={section==='admin'}/>;
 if(section==='docs'||section==='bot')return <Documentation bot={section==='bot'}/>;
 if(section==='terms'||section==='aup')return <Policy aup={section==='aup'}/>;
 if(section==='changelog')return <Changelog/>;
 notFound();
}
