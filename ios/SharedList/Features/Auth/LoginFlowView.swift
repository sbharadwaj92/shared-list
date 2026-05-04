import SwiftUI

// LoginFlowView is the unauthenticated entry point. Two tabs (sign up / log
// in) sharing one state container so swapping between them keeps fields
// populated. The state lives in a view-local @State LoginFlowModel; we don't
// need the @Observable ceremony for ephemeral input state.

struct LoginFlowView: View {
    @Environment(\.appContainer) private var container
    @State private var mode: Mode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    enum Mode: String, CaseIterable, Identifiable {
        case login = "Log In"
        case signup = "Sign Up"
        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(mode == .signup ? .newPassword : .password)
                    if mode == .signup {
                        TextField("Display name", text: $displayName)
                            .textContentType(.name)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text(mode.rawValue)
                                    .bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit || isSubmitting)
                }
            }
            .navigationTitle("SharedList")
        }
    }

    private var canSubmit: Bool {
        // Only block the empty-field cases so the button isn't usable with
        // no input at all. We deliberately do NOT mirror the backend's
        // password-length / email-format rules client-side — the backend is
        // the source of truth, and mirroring its constraints here means two
        // copies that can drift. If the user submits something the backend
        // rejects (422 / 400 / 409), we surface the message verbatim from
        // the error envelope. The trade-off: occasional "wasted" round trip
        // when input is invalid, which is fine for three-user LAN scale.
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else { return false }
        if mode == .signup {
            guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return false
            }
        }
        return true
    }

    private func submit() {
        guard let container else { return }
        errorMessage = nil
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            do {
                switch mode {
                case .signup:
                    _ = try await container.auth.signup(
                        email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                        password: password,
                        displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                    )
                case .login:
                    _ = try await container.auth.login(
                        email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                        password: password
                    )
                }
                // Successful auth flips TokenStore.current to non-nil; RootView
                // observes it and switches to the post-login surface.
            } catch let error as APIError {
                errorMessage = displayMessage(for: error)
            } catch {
                errorMessage = "Unexpected error: \(error.localizedDescription)"
            }
        }
    }

    private func displayMessage(for error: APIError) -> String {
        switch error {
        case .server(let status, _, let message, _):
            // Surface the server's message (already user-facing) plus status
            // for context. Future iteration: map specific codes to friendlier
            // copy ("Email already registered" instead of the raw 409 text).
            return "[\(status)] \(message)"
        case .notAuthenticated:
            return "Not authenticated."
        case .decoding(let detail):
            return "Couldn't read server response: \(detail)"
        case .transport(let detail):
            return "Network error: \(detail)"
        case .refreshFailed:
            return "Session expired. Please log in again."
        }
    }
}

#Preview("Login mode") {
    LoginFlowView()
        .environment(\.appContainer, PreviewSupport.loggedOutContainer())
}

#Preview("Signup mode") {
    LoginFlowView()
        .environment(\.appContainer, PreviewSupport.loggedOutContainer())
}
