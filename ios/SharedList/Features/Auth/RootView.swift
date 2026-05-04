import SwiftUI

// RootView decides "logged in vs logged out" by reading TokenStore from the
// AppContainer. The @Observable nature of TokenStore means this view re-renders
// when `current` flips between nil and a value, so login/logout transitions
// are automatic — no NotificationCenter, no Combine publisher.
//
// Phase 5 only ships the auth surface; once we have lists (Phase 13), the
// "logged in" branch will become a TabView. For now it's a placeholder
// "Hello, <displayName>" + a Sign Out button, so the full login → logout →
// login cycle is testable end-to-end.

struct RootView: View {
    @Environment(\.appContainer) private var container

    var body: some View {
        Group {
            if let container {
                if container.tokenStore.current == nil {
                    LoginFlowView()
                } else {
                    AuthenticatedHomePlaceholder()
                }
            } else {
                // No container injected — only happens in misconfigured
                // previews or test harnesses that mount RootView directly.
                // Show a neutral placeholder rather than crashing.
                ProgressView()
            }
        }
    }
}

// Placeholder for the post-login app surface. Replaced in Phase 13 by the
// real ListsTabView. Lives here (not in its own file) because it's
// throwaway scaffolding that exists only so we can verify logout works.
private struct AuthenticatedHomePlaceholder: View {
    @Environment(\.appContainer) private var container
    @State private var isSigningOut = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.green)
                    .padding(.top, 48)
                if let user = container?.tokenStore.current?.user {
                    Text("Signed in as")
                        .foregroundStyle(.secondary)
                    Text(user.displayName)
                        .font(.title2)
                        .bold()
                    Text(user.email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(role: .destructive) {
                    guard let container else { return }
                    isSigningOut = true
                    Task {
                        await container.auth.logout()
                        isSigningOut = false
                    }
                } label: {
                    if isSigningOut {
                        ProgressView()
                    } else {
                        Text("Sign Out")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal)
                .padding(.bottom, 32)
                .disabled(isSigningOut)
            }
            .navigationTitle("SharedList")
        }
    }
}

#Preview("Logged out") {
    let container = PreviewSupport.loggedOutContainer()
    RootView()
        .environment(\.appContainer, container)
}

#Preview("Logged in") {
    let container = PreviewSupport.loggedInContainer()
    RootView()
        .environment(\.appContainer, container)
}
