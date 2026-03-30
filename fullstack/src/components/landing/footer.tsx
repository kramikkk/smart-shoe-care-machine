'use client'

import { useRef, useEffect } from 'react'
import { gsap } from '@/lib/gsap'
import Link from 'next/link'
import Image from 'next/image'
import { Logo } from '@/components/landing/logo'

const links = [
    { label: 'Home', href: '#home' },
    { label: 'Features', href: '#features' },
    { label: 'FAQs', href: '#faqs' },
    { label: 'Contact', href: '#contact' },
]

const team = [
    { name: 'Mark Jeric B. Exconde', github: 'kramikkk' },
    { name: 'Jasmine Q. Macalintal', github: 'Mimineeeee' },
    { name: 'Zyra Mae G. Flores', github: 'ZyraFlores' },
    { name: 'John Raymon D. Guran', github: 'Raymon0527' },
]

export default function Footer() {
    const footerRef = useRef<HTMLElement>(null)

    useEffect(() => {
        const ctx = gsap.context(() => {
            gsap.from(footerRef.current, {
                opacity: 0,
                y: 20,
                duration: 1,
                scrollTrigger: {
                    trigger: footerRef.current,
                    start: 'top 95%',
                },
            })
        }, footerRef)

        return () => ctx.revert()
    }, [])

    return (
        <footer ref={footerRef} className="bg-background py-12 sm:py-16 border-t border-white/5 relative overflow-hidden">
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-[500px] bg-primary/[0.03] blur-[120px] rounded-full pointer-events-none" />

            <div className="container mx-auto px-6 max-w-7xl relative z-10">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 md:gap-12 mb-12 sm:mb-16">

                    {/* Col 1 — Brand */}
                    <div className="col-span-1">
                        <Link href="/" className="inline-block mb-6">
                            <Logo />
                        </Link>
                        <p className="text-muted-foreground text-sm leading-relaxed">
                            Revolutionizing shoe care through intelligent automation, IoT integration, and AI-powered recognition. The future of footwear maintenance is here.
                        </p>
                    </div>

                    {/* Col 2 — Navigation */}
                    <div className="col-span-1">
                        <h4 className="uppercase tracking-widest text-xs mb-6">Navigation</h4>
                        <ul className="space-y-4">
                            {links.map((link) => (
                                <li key={link.label}>
                                    <Link href={link.href} className="text-muted-foreground hover:text-primary transition-colors text-sm">
                                        {link.label}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Col 3 — The Team */}
                    <div className="col-span-1">
                        <h4 className="uppercase tracking-widest text-xs mb-6">The Team</h4>
                        <ul className="space-y-3">
                            {team.map(({ name, github }) => (
                                <li key={name} className="flex items-center gap-3">
                                    <Image
                                        src={`https://avatars.githubusercontent.com/${github}`}
                                        alt={name}
                                        width={28}
                                        height={28}
                                        className="rounded-full border border-primary/20 shrink-0"
                                    />
                                    <span className="text-muted-foreground text-sm leading-snug">{name}</span>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Col 4 — Institution */}
                    <div className="col-span-1">
                        <h4 className="uppercase tracking-widest text-xs mb-6">Institution</h4>
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-foreground/70 font-semibold leading-snug">
                                Laguna State Polytechnic University
                            </p>
                            <p className="text-xs text-muted-foreground leading-snug">
                                San Pablo City Campus
                            </p>
                            <div className="h-px w-8 bg-white/10 my-1" />
                            <p className="text-xs text-muted-foreground leading-snug">
                                College of Engineering
                            </p>
                            <p className="text-xs text-muted-foreground leading-snug">
                                Bachelor of Science in<br />Computer Engineering
                            </p>
                        </div>
                    </div>

                </div>

                <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
                    <p>&copy; {new Date().getFullYear()} Smart Shoe Care Machine. All rights reserved.</p>
                    <div className="flex items-center gap-4">
                        <span className="font-mono text-xs">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
                        <p className="flex items-center gap-2">
                            Designed for <span className="text-foreground font-bold tracking-tighter">THESIS</span>
                        </p>
                    </div>
                </div>
            </div>
        </footer>
    )
}
