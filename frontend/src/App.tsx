import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react";
import { Button } from "@/components/ui/button";

function App() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-foreground">
            <header className="flex w-full max-w-lg items-center justify-between">
                <h1 className="text-2xl font-semibold">maxterview</h1>
                <Show when="signed-in">
                    <UserButton />
                </Show>
            </header>

            <main className="w-full max-w-lg rounded-lg border bg-card p-8 text-card-foreground shadow-sm">
                <p className="mb-4 text-muted-foreground">AI mock-interview coach. Sign in to start practicing.</p>
                <Show when="signed-out">
                    <div className="flex gap-3">
                        <Button asChild>
                            <SignInButton />
                        </Button>
                        <Button asChild variant="outline">
                            <SignUpButton />
                        </Button>
                    </div>
                </Show>
                <Show when="signed-in">
                    <Button>Continue</Button>
                </Show>
            </main>
        </div>
    );
}

export default App;
