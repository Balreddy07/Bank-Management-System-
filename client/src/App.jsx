
import { useEffect, useRef, useState } from "react";
import "./App.css";

const API = (import.meta.env.VITE_API_BASE || "/api").replace(/\/$/, "");

const menu = [
  { name: "Dashboard", icon: "▦" },
  { name: "Accounts", icon: "▤" },
  { name: "Transactions", icon: "⇄" },
  { name: "Reports", icon: "▥" },
  { name: "Administration", icon: "⚙" },
];

const initialForm = {
  fullName: "",
  address: "",
  phone: "",
  idProofType: "PAN",
  idProofNumber: "",
  initialDeposit: "500",
};

function localDateString(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(Number(value) || 0);
}

export default function App() {
  const [authStatus, setAuthStatus] = useState("checking");
  const [currentUser, setCurrentUser] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("Dashboard");
  const [form, setForm] = useState(initialForm);
  const [accounts, setAccounts] = useState([]);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountDetails, setAccountDetails] = useState(null);
  const [accountDetailsLoading, setAccountDetailsLoading] = useState(false);
  const [editingAccount, setEditingAccount] = useState(false);
  const [accountEditForm, setAccountEditForm] = useState({ fullName: "", address: "", phone: "" });
  const [accountEditLoading, setAccountEditLoading] = useState(false);
  const [selectedAccountNumber, setSelectedAccountNumber] = useState("");
  const selectedAccountNumberRef = useRef("");
  const [transactionAccount, setTransactionAccount] = useState(null);
  const [transactionHistory, setTransactionHistory] = useState([]);
  const [transactionHistoryLoading, setTransactionHistoryLoading] = useState(false);
  const [transactionMode, setTransactionMode] = useState("DEPOSIT");
  const [transactionAmount, setTransactionAmount] = useState("");
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [transactionResult, setTransactionResult] = useState(null);
  const [reportDates, setReportDates] = useState(() => {
    const today = new Date();
    return {
      startDate: localDateString(new Date(today.getFullYear(), today.getMonth(), 1)),
      endDate: localDateString(today),
    };
  });
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");
  const [health, setHealth] = useState("Checking");
  const [notice, setNotice] = useState(null);
  const [createdAccount, setCreatedAccount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [staff, setStaff] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffForm, setStaffForm] = useState({ username: "", password: "", role: "STAFF" });

  async function apiFetch(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      ...options,
    });
    if (response.status === 401 && !path.startsWith("/auth/")) {
      setCurrentUser(null);
      setAuthStatus("signed-out");
      setSessionExpired(true);
      clearProtectedData();
    }
    return response;
  }

  function clearProtectedData() {
    setAccounts([]);
    setAccountSearch("");
    setAccountDetails(null);
    setEditingAccount(false);
    selectedAccountNumberRef.current = "";
    setSelectedAccountNumber("");
    setTransactionAccount(null);
    setTransactionHistory([]);
    setTransactionAmount("");
    setReportData(null);
    setStaff([]);
    setStaffForm({ username: "", password: "", role: "STAFF" });
    setCreatedAccount(null);
    setTransactionResult(null);
    setForm(initialForm);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/auth/session`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Authentication service is unavailable.");
        if (cancelled) return;
        setCurrentUser(data.user);
        setAuthStatus(data.user ? "signed-in" : "signed-out");
        setSessionExpired(Boolean(data.sessionExpired));
        if (data.user?.role === "STAFF") setActiveTab("Accounts");
      })
      .catch((error) => {
        if (!cancelled) {
          setAuthError(error.message);
          setAuthStatus("signed-out");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "signed-in" || !currentUser) return;
    let cancelled = false;

    fetch(`${API}/health/db`)
      .then((response) => {
        if (!response.ok) throw new Error("Database unavailable");
        return response.json();
      })
      .then((data) => {
        if (!cancelled) {
          setHealth(
            data.database === "connected" ? "Connected" : "Unavailable"
          );
        }
      })
      .catch(() => {
        if (!cancelled) setHealth("Unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [authStatus, currentUser]);

  useEffect(() => {
    if (authStatus !== "signed-in" || (activeTab !== "Accounts" && activeTab !== "Transactions")) return;

    const controller = new AbortController();

    async function loadAccounts() {
      setAccountsLoading(true);

      try {
        const params = new URLSearchParams();

        if (activeTab === "Accounts" && accountSearch.trim()) {
          params.set("search", accountSearch.trim());
        }

        const response = await apiFetch(
          `/accounts?${params.toString()}`,
          { signal: controller.signal }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Could not load accounts.");
        }

        setAccounts(data.accounts || []);
        if (activeTab === "Transactions") {
          const next = data.accounts?.some(
            (account) => account.accountNumber === selectedAccountNumberRef.current
          )
            ? selectedAccountNumberRef.current
            : data.accounts?.[0]?.accountNumber || "";
          selectedAccountNumberRef.current = next;
          setSelectedAccountNumber(next);
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          setNotice({ type: "error", text: error.message });
        }
      } finally {
        if (!controller.signal.aborted) {
          setAccountsLoading(false);
        }
      }
    }

    loadAccounts();
    return () => controller.abort();
  }, [activeTab, accountSearch, authStatus]);

  useEffect(() => {
    if (activeTab !== "Transactions" || !selectedAccountNumber) {
      return;
    }

    const controller = new AbortController();

    async function loadTransactionHistory() {
      setTransactionHistoryLoading(true);
      try {
        const params = new URLSearchParams({ accountNumber: selectedAccountNumber });
        const response = await apiFetch(`/transactions?${params}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (
          controller.signal.aborted ||
          selectedAccountNumberRef.current !== selectedAccountNumber
        ) {
          return;
        }
        if (!response.ok) throw new Error(data.message || "Could not load transaction history.");
        setTransactionAccount(data.account);
        setTransactionHistory(data.transactions || []);
      } catch (error) {
        if (error.name !== "AbortError") {
          setTransactionAccount(null);
          setTransactionHistory([]);
          setNotice({ type: "error", text: error.message });
        }
      } finally {
        if (!controller.signal.aborted) setTransactionHistoryLoading(false);
      }
    }

    loadTransactionHistory();
    return () => controller.abort();
  }, [activeTab, selectedAccountNumber, authStatus]);

  useEffect(() => {
    if (authStatus !== "signed-in" || currentUser?.role !== "ADMIN" || (activeTab !== "Dashboard" && activeTab !== "Reports")) return;
    if (!reportDates.startDate || !reportDates.endDate) return;

    const controller = new AbortController();
    async function loadReport() {
      setReportLoading(true);
      setReportError("");
      setReportData(null);
      try {
        const params = new URLSearchParams(reportDates);
        const response = await apiFetch(`/reports?${params}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Could not load report data.");
        setReportData(data);
      } catch (error) {
        if (error.name !== "AbortError") {
          setReportData(null);
          setReportError(error.message);
        }
      } finally {
        if (!controller.signal.aborted) setReportLoading(false);
      }
    }

    loadReport();
    return () => controller.abort();
  }, [activeTab, reportDates, authStatus, currentUser]);

  useEffect(() => {
    if (authStatus !== "signed-in" || currentUser?.role !== "ADMIN" || activeTab !== "Administration") return;
    const controller = new AbortController();
    async function loadStaff() {
      setStaffLoading(true);
      try {
        const response = await apiFetch("/admin/staff", { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Could not load staff accounts.");
        setStaff(data.staff || []);
      } catch (error) {
        if (error.name !== "AbortError") setNotice({ type: "error", text: error.message });
      } finally {
        if (!controller.signal.aborted) setStaffLoading(false);
      }
    }
    loadStaff();
    return () => controller.abort();
  }, [activeTab, authStatus, currentUser]);

  function navigate(page) {
    if (currentUser?.role === "STAFF" && !["Accounts", "Transactions"].includes(page)) {
      page = "Accounts";
    }
    setActiveTab(page);
    setNotice(null);
    setCreatedAccount(null);
    setTransactionResult(null);
  }

  async function login(event) {
    event.preventDefault();
    setLoginLoading(true);
    setAuthError("");
    try {
      const response = await fetch(`${API}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: event.currentTarget.username.value,
          password: event.currentTarget.password.value,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Unable to sign in.");
      setCurrentUser(data.user);
      setAuthStatus("signed-in");
      setSessionExpired(false);
      clearProtectedData();
      setActiveTab(data.user.role === "ADMIN" ? "Dashboard" : "Accounts");
    } catch (error) {
      setAuthError(error.message === "Failed to fetch"
        ? "The authentication service cannot be reached. Check that the API is running."
        : error.message);
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout() {
    try {
      const response = await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Unable to sign out. Please retry.");
      setCurrentUser(null);
      setAuthStatus("signed-out");
      setSessionExpired(false);
      setActiveTab("Dashboard");
      clearProtectedData();
    } catch (error) {
      setNotice({ type: "error", text: error.message || "Unable to sign out. Please retry." });
    }
  }

  function updateField(event) {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
  }

  async function createAccount(event) {
    event.preventDefault();
    setNotice(null);
    setCreatedAccount(null);

    const deposit = Number(form.initialDeposit);

    if (!Number.isFinite(deposit) || deposit < 500) {
      setNotice({
        type: "error",
        text: "The minimum initial deposit is ₹500.",
      });
      return;
    }

    setLoading(true);

    try {
      const response = await apiFetch("/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          initialDeposit: deposit,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Unable to create the account.");
      }

      setCreatedAccount(data.account);
      setNotice({
        type: "success",
        text: data.message || "Account created successfully.",
      });
      setForm(initialForm);

      // Refresh the account directory after a successful creation.
      const refresh = await apiFetch("/accounts");
      if (refresh.ok) {
        const refreshedData = await refresh.json();
        setAccounts(refreshedData.accounts || []);
      }
    } catch (error) {
      setNotice({
        type: "error",
        text:
          error.message === "Failed to fetch"
            ? "Cannot reach the backend. Check that your server is running on port 5000."
            : error.message,
      });
    } finally {
      setLoading(false);
    }
  }

  async function submitTransaction(event) {
    event.preventDefault();
    setNotice(null);
    setTransactionResult(null);

    const accountNumber = selectedAccountNumber;
    if (!selectedAccountNumber || transactionAccount?.status !== "ACTIVE") {
      setNotice({ type: "error", text: "Choose an active account to continue." });
      return;
    }

    if (!/^\d+(?:\.\d{1,2})?$/.test(transactionAmount) || Number(transactionAmount) <= 0) {
      setNotice({ type: "error", text: "Enter an amount greater than zero with up to two decimal places." });
      return;
    }

    if (transactionMode === "WITHDRAWAL" && !window.confirm(
      `Withdraw ${money(transactionAmount)} from account ${selectedAccountNumber}?`
    )) {
      return;
    }

    setTransactionLoading(true);
    try {
      const response = await apiFetch(
        `/transactions/${transactionMode === "DEPOSIT" ? "deposit" : "withdraw"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountNumber,
            amount: Number(transactionAmount),
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Transaction could not be completed.");

      setTransactionResult(data.transaction);
      if (selectedAccountNumberRef.current === accountNumber) {
        setTransactionAccount((previous) => ({
          ...previous,
          ...data.account,
        }));
      }
      setNotice({ type: "success", text: data.message });
      setTransactionAmount("");

      const params = new URLSearchParams({ accountNumber });
      const historyResponse = await apiFetch(`/transactions?${params}`);
      if (historyResponse.ok) {
        const historyData = await historyResponse.json();
        if (selectedAccountNumberRef.current === accountNumber) {
          setTransactionAccount(historyData.account);
          setTransactionHistory(historyData.transactions || []);
        }
      }
    } catch (error) {
      setNotice({
        type: "error",
        text: error.message === "Failed to fetch"
          ? "Cannot reach the backend. Check that your server is running on port 5000."
          : error.message,
      });
    } finally {
      setTransactionLoading(false);
    }
  }

  async function createStaff(event) {
    event.preventDefault();
    setNotice(null);
    try {
      const response = await apiFetch("/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(staffForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not create staff account.");
      setNotice({ type: "success", text: data.message });
      setStaffForm({ username: "", password: "", role: "STAFF" });
      const refreshed = await apiFetch("/admin/staff");
      const refreshedData = await refreshed.json();
      if (refreshed.ok) setStaff(refreshedData.staff || []);
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }

  async function viewAccount(accountNumber) {
    setAccountDetails(null);
    setEditingAccount(false);
    setAccountDetailsLoading(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/accounts/${accountNumber}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load account details.");
      setAccountDetails(data.account);
      return data.account;
    } catch (error) {
      setNotice({ type: "error", text: error.message });
      return null;
    } finally {
      setAccountDetailsLoading(false);
    }
  }

  function beginAccountEdit(account) {
    setAccountEditForm({
      fullName: account.fullName,
      address: account.address,
      phone: account.phone,
    });
    setEditingAccount(true);
    setNotice(null);
  }

  async function saveAccountEdit(event) {
    event.preventDefault();
    if (!accountDetails) return;
    setAccountEditLoading(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/accounts/${accountDetails.accountNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accountEditForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not update customer details.");
      setAccountDetails((previous) => ({ ...previous, ...data.account }));
      setAccounts((previous) => previous.map((account) =>
        account.accountNumber === data.account.accountNumber
          ? { ...account, ...data.account }
          : account
      ));
      setEditingAccount(false);
      setNotice({ type: "success", text: data.message });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally {
      setAccountEditLoading(false);
    }
  }

  async function updateStaffRole(userId, role) {
    try {
      const response = await apiFetch(`/admin/staff/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not update role.");
      setNotice({ type: "success", text: data.message });
      setStaff((previous) => previous.map((person) =>
        person.userId === userId ? { ...person, role } : person
      ));
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }

  async function deactivateAccount(accountNumber) {
    if (!window.confirm(`Deactivate account ${accountNumber}? Further transactions will be blocked.`)) return;
    try {
      const response = await apiFetch(`/accounts/${accountNumber}/deactivate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not deactivate account.");
      setAccounts((previous) => previous.map((account) =>
        account.accountNumber === accountNumber ? { ...account, status: data.status } : account
      ));
      setAccountDetails((previous) =>
        previous?.accountNumber === accountNumber ? { ...previous, status: data.status } : previous
      );
      setNotice({ type: "success", text: data.message });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  }

  if (authStatus === "checking") {
    return (
      <div className="auth-loading" role="status">
        <span className="spinner" /> Checking secure session...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginScreen
        onSubmit={login}
        loading={loginLoading}
        error={authError}
        expired={sessionExpired}
      />
    );
  }

  const visibleMenu = menu.filter((item) => {
    if (currentUser.role === "ADMIN") return true;
    return item.name === "Accounts" || item.name === "Transactions";
  });

  return (
    <div className="bank-app">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("Dashboard")}>
          <span className="brand-mark">S</span>
          <span className="brand-copy">
            <strong>SecureBank</strong>
            <small>Banking platform</small>
          </span>
        </button>

        <div className="sidebar-section-label">WORKSPACE</div>

        <nav className="navigation" aria-label="Main navigation">
          {visibleMenu.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${
                activeTab === item.name ? "nav-item-active" : ""
              }`}
              onClick={() => navigate(item.name)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.name}</span>
              {activeTab === item.name && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="security-card">
            <div className="security-icon">⌑</div>
            <strong>Secure environment</strong>
            <p>Local development workspace</p>
            <div className="security-status">
              <span className={`status-dot ${health === "Connected" ? "dot-green" : ""}`} />
              API database: {health}
            </div>
          </div>

          <div className="profile">
            <div className="avatar">AD</div>
            <div className="profile-info">
              <strong>{currentUser.username}</strong>
              <small>{currentUser.role}</small>
            </div>
            <button className="logout-button" type="button" onClick={logout} title="Sign out" aria-label="Sign out">
              ↪
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{activeTab}</strong>
          </div>
          <div className="topbar-right">
            <span className="live-indicator">
              <span className={`status-dot ${health === "Connected" ? "dot-green" : ""}`} />
              {health === "Connected" ? "System connected" : health}
            </span>
            <button className="top-logout" type="button" onClick={logout}>Sign out</button>
            <div className="top-avatar" aria-hidden="true">{currentUser.username.slice(0, 2).toUpperCase()}</div>
          </div>
        </header>

        <div className="page-content">
          {activeTab === "Dashboard" && (
            <Dashboard
              onOpenAccounts={() => navigate("Accounts")}
              onOpenTransactions={() => navigate("Transactions")}
              health={health}
              reportData={reportData}
              reportLoading={reportLoading}
              reportDates={reportDates}
            />
          )}

          {activeTab === "Accounts" && (
            <section>
              <PageHeading
                eyebrow="CUSTOMER MANAGEMENT"
                title="Accounts"
                description="Register customers, create bank accounts, and search existing records."
              />

              {notice && <Notice notice={notice} />}

              {createdAccount && (
                <div className="created-card">
                  <div className="created-icon">✓</div>
                  <div className="created-copy">
                    <strong>Account successfully created</strong>
                    <p>Keep the account number secure.</p>
                    <div className="created-details">
                      <span>Account number</span>
                      <strong>{createdAccount.accountNumber}</strong>
                      <span>Customer ID</span>
                      <strong>{createdAccount.customerId}</strong>
                      <span>Opening balance</span>
                      <strong>{money(createdAccount.balance)}</strong>
                    </div>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(
                        createdAccount.accountNumber
                      );
                    }}
                  >
                    Copy account no.
                  </button>
                </div>
              )}

              <form className="form-card" onSubmit={createAccount}>
                <div className="form-card-heading">
                  <div className="form-heading-icon">♙</div>
                  <div>
                    <h2>Customer information</h2>
                    <p>Fields marked with * are required.</p>
                  </div>
                  <span className="required-tag">KYC required</span>
                </div>

                <div className="form-divider" />

                <div className="form-grid">
                  <FormField label="Full name" required>
                    <input
                      name="fullName"
                      value={form.fullName}
                      onChange={updateField}
                      placeholder="Enter customer's full name"
                      maxLength={100}
                      autoComplete="name"
                      required
                    />
                  </FormField>

                  <FormField label="Phone number" required>
                    <input
                      name="phone"
                      type="tel"
                      value={form.phone}
                      onChange={updateField}
                      placeholder="+91 98765 43210"
                      autoComplete="tel"
                      maxLength={20}
                      required
                    />
                  </FormField>

                  <FormField label="Residential address" required wide>
                    <input
                      name="address"
                      value={form.address}
                      onChange={updateField}
                      placeholder="Street, locality, city, PIN code"
                      maxLength={255}
                      autoComplete="street-address"
                      required
                    />
                  </FormField>

                  <FormField label="Identification type" required>
                    <select
                      name="idProofType"
                      value={form.idProofType}
                      onChange={updateField}
                      required
                    >
                      <option value="PAN">PAN card</option>
                      <option value="Aadhaar">Aadhaar card</option>
                      <option value="Passport">Passport</option>
                      <option value="Voter ID">Voter ID</option>
                      <option value="Driving Licence">Driving licence</option>
                    </select>
                  </FormField>

                  <FormField label="Identification number" required>
                    <input
                      name="idProofNumber"
                      value={form.idProofNumber}
                      onChange={updateField}
                      placeholder="Enter ID proof number"
                      maxLength={100}
                      required
                    />
                  </FormField>
                </div>

                <div className="form-divider section-divider" />

                <div className="form-card-heading">
                  <div className="form-heading-icon rupee-icon">₹</div>
                  <div>
                    <h2>Account setup</h2>
                    <p>Choose the opening deposit amount.</p>
                  </div>
                </div>

                <div className="deposit-box">
                  <FormField label="Initial deposit amount (INR)" required>
                    <div className="currency-input">
                      <span>₹</span>
                      <input
                        name="initialDeposit"
                        type="number"
                        value={form.initialDeposit}
                        onChange={updateField}
                        min="500"
                        max="9999999999.99"
                        step="0.01"
                        required
                      />
                    </div>
                    <small className="field-hint">
                      Minimum opening deposit: ₹500.00
                    </small>
                  </FormField>

                  <div className="account-preview">
                    <span>Account type</span>
                    <strong>Standard savings</strong>
                    <span>Initial account status</span>
                    <strong className="active-label">
                      <span className="status-dot dot-green" /> Active
                    </strong>
                  </div>
                </div>

                <div className="form-footer">
                  <p>
                    <span className="lock-symbol">⌑</span>
                    Customer details are submitted to your local API.
                  </p>
                  <button className="primary-button" type="submit" disabled={loading}>
                    {loading ? (
                      <>
                        <span className="spinner" /> Creating account...
                      </>
                    ) : (
                      <>Create account <span>→</span></>
                    )}
                  </button>
                </div>
              </form>

              <div className="directory-heading">
                <div>
                  <h2>Account directory</h2>
                  <p>Search customer records and review account balances.</p>
                </div>
                <span className="directory-count">{accounts.length} shown</span>
              </div>

              <div className="directory-search">
                <span>⌕</span>
                <input
                  type="search"
                  placeholder="Search by account number or customer name..."
                  value={accountSearch}
                  onChange={(event) => setAccountSearch(event.target.value)}
                  maxLength={100}
                  aria-label="Search accounts"
                />
                {accountSearch && (
                  <button type="button" onClick={() => setAccountSearch("")}>
                    Clear
                  </button>
                )}
              </div>

              <div className="table-card">
                {accountsLoading ? (
                  <div className="table-message">Loading accounts...</div>
                ) : accounts.length === 0 ? (
                  <div className="table-message">
                    <strong>No accounts found</strong>
                    <p>Try another search or create a new account above.</p>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table className="accounts-table">
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Account number</th>
                          <th>Phone</th>
                          <th>Balance</th>
                          <th>Status</th>
                          <th><span className="visually-hidden">Account actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {accounts.map((account) => (
                          <tr key={account.accountId}>
                            <td>
                              <div className="customer-cell">
                                <span className="customer-avatar">
                                  {(account.fullName || "?").charAt(0).toUpperCase()}
                                </span>
                                <span>
                                  <strong>{account.fullName}</strong>
                                  <small>ID: {account.customerId}</small>
                                </span>
                              </div>
                            </td>
                            <td className="account-number-cell">{account.accountNumber}</td>
                            <td>{account.phone}</td>
                            <td className="balance-cell">{money(account.balance)}</td>
                            <td>
                              <span className={`account-status ${
                                account.status === "ACTIVE"
                                  ? "account-active"
                                  : "account-inactive"
                              }`}>
                                <span />
                                {account.status}
                              </span>
                            </td>
                            <td>
                              <div className="table-actions">
                                <button
                                  className="table-action"
                                  type="button"
                                  onClick={() => viewAccount(account.accountNumber)}
                                  aria-label={`View account ${account.accountNumber}`}
                                >View</button>
                                <button
                                  className="table-action"
                                  type="button"
                                  onClick={async () => {
                                    const details = await viewAccount(account.accountNumber);
                                    if (details) beginAccountEdit(details);
                                  }}
                                  aria-label={`Edit customer details for ${account.accountNumber}`}
                                >Edit</button>
                                <button
                                  className="table-action"
                                  type="button"
                                  onClick={() => {
                                    selectedAccountNumberRef.current = account.accountNumber;
                                    setSelectedAccountNumber(account.accountNumber);
                                    navigate("Transactions");
                                  }}
                                  aria-label={`Transact on account ${account.accountNumber}`}
                                >Transact</button>
                                {account.status === "ACTIVE" && (
                                  <button
                                    className="table-action table-action-danger"
                                    type="button"
                                    onClick={() => deactivateAccount(account.accountNumber)}
                                  >Deactivate</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {accountDetailsLoading && <div className="table-message" role="status">Loading account details...</div>}
              {accountDetails && (
                <section className="form-card account-details-card" aria-label="Customer account details">
                  <div className="form-card-heading">
                    <div className="form-heading-icon">▤</div>
                    <div>
                      <h2>Account details</h2>
                      <p>Account number {accountDetails.accountNumber}</p>
                    </div>
                    <button className="secondary-button" type="button" onClick={() => {
                      setAccountDetails(null);
                      setEditingAccount(false);
                    }}>Close</button>
                  </div>
                  {editingAccount ? (
                    <form onSubmit={saveAccountEdit}>
                      <div className="form-grid">
                        <FormField label="Full name" required>
                          <input
                            value={accountEditForm.fullName}
                            onChange={(event) => setAccountEditForm((previous) => ({ ...previous, fullName: event.target.value }))}
                            maxLength={100}
                            required
                          />
                        </FormField>
                        <FormField label="Phone number" required>
                          <input
                            type="tel"
                            value={accountEditForm.phone}
                            onChange={(event) => setAccountEditForm((previous) => ({ ...previous, phone: event.target.value }))}
                            maxLength={20}
                            required
                          />
                        </FormField>
                        <FormField label="Residential address" required wide>
                          <input
                            value={accountEditForm.address}
                            onChange={(event) => setAccountEditForm((previous) => ({ ...previous, address: event.target.value }))}
                            maxLength={255}
                            required
                          />
                        </FormField>
                      </div>
                      <div className="form-footer">
                        <button className="secondary-button" type="button" onClick={() => setEditingAccount(false)}>Cancel</button>
                        <button className="primary-button" type="submit" disabled={accountEditLoading}>
                          {accountEditLoading ? "Saving..." : "Save changes"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="created-details">
                      <span>Customer</span><strong>{accountDetails.fullName}</strong>
                      <span>Customer ID</span><strong>{accountDetails.customerId}</strong>
                      <span>Address</span><strong>{accountDetails.address}</strong>
                      <span>Phone</span><strong>{accountDetails.phone}</strong>
                      <span>Balance</span><strong>{money(accountDetails.balance)}</strong>
                      <span>Status</span><strong>{accountDetails.status}</strong>
                      <span>Opened</span><strong>{new Date(accountDetails.createdAt).toLocaleDateString("en-IN")}</strong>
                    </div>
                  )}
                </section>
              )}
            </section>
          )}

          {activeTab === "Transactions" && (
            <section>
              <PageHeading
                eyebrow="ACCOUNT ACTIVITY"
                title="Transactions"
                description="Post deposits and withdrawals against an active account."
              />

              {notice && <Notice notice={notice} />}

              {transactionResult && (
                <div className="transaction-result" role="status">
                  <div>
                    <span>{transactionResult.type === "DEPOSIT" ? "Deposit receipt" : "Withdrawal receipt"}</span>
                    <strong>{transactionResult.transactionRef}</strong>
                  </div>
                  <div>
                    <span>Amount</span>
                    <strong>{money(transactionResult.amount)}</strong>
                  </div>
                  <div>
                    <span>Updated balance</span>
                    <strong>{money(transactionResult.balanceAfter)}</strong>
                  </div>
                  <div>
                    <span>Date and time</span>
                    <strong>{new Date(transactionResult.createdAt).toLocaleString("en-IN")}</strong>
                  </div>
                </div>
              )}

              <div className="transaction-layout">
                <form className="form-card transaction-form" onSubmit={submitTransaction}>
                  <div className="form-card-heading">
                    <div className="form-heading-icon rupee-icon">₹</div>
                    <div>
                      <h2>New transaction</h2>
                      <p>Account balance is verified by the server before posting.</p>
                    </div>
                  </div>

                  <div className="form-divider" />

                  <FormField label="Account" required>
                    <select
                      value={selectedAccountNumber}
                      onChange={(event) => {
                        const nextAccountNumber = event.target.value;
                        selectedAccountNumberRef.current = nextAccountNumber;
                        setSelectedAccountNumber(nextAccountNumber);
                        setTransactionResult(null);
                        setNotice(null);
                      }}
                      required
                    >
                      <option value="">Select an account</option>
                      {accounts.map((account) => (
                        <option key={account.accountId} value={account.accountNumber}>
                          {account.accountNumber} · {account.fullName} · {account.status}
                        </option>
                      ))}
                    </select>
                  </FormField>

                  <div className="balance-summary">
                    <span>Current balance</span>
                    <strong>
                      {transactionHistoryLoading
                        ? "Loading..."
                        : transactionAccount?.accountNumber === selectedAccountNumber
                          ? money(transactionAccount.balance)
                          : "Unavailable"}
                    </strong>
                    {transactionAccount?.status && (
                      <span className={`account-status ${transactionAccount.status === "ACTIVE" ? "account-active" : "account-inactive"}`}>
                        <span />{transactionAccount.status}
                      </span>
                    )}
                  </div>

                  <div className="transaction-mode" role="group" aria-label="Transaction type">
                    <button
                      type="button"
                      className={transactionMode === "DEPOSIT" ? "mode-active mode-deposit" : ""}
                      aria-pressed={transactionMode === "DEPOSIT"}
                      onClick={() => setTransactionMode("DEPOSIT")}
                    >
                      Deposit
                    </button>
                    <button
                      type="button"
                      className={transactionMode === "WITHDRAWAL" ? "mode-active mode-withdrawal" : ""}
                      aria-pressed={transactionMode === "WITHDRAWAL"}
                      onClick={() => setTransactionMode("WITHDRAWAL")}
                    >
                      Withdraw
                    </button>
                  </div>

                  <FormField label="Amount (INR)" required>
                    <div className="currency-input">
                      <span>₹</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        max="9999999999.99"
                        step="0.01"
                        value={transactionAmount}
                        onChange={(event) => setTransactionAmount(event.target.value)}
                        placeholder="0.00"
                        required
                      />
                    </div>
                    <small className="field-hint">
                      {transactionMode === "WITHDRAWAL"
                        ? "Minimum remaining balance: ₹1,000.00"
                        : "Maximum supported amount: ₹9,999,999,999.99"}
                    </small>
                  </FormField>

                  <button
                    className="primary-button transaction-submit"
                    type="submit"
                    disabled={transactionLoading || !selectedAccountNumber || transactionAccount?.status !== "ACTIVE"}
                  >
                    {transactionLoading ? (
                      <><span className="spinner" /> Processing...</>
                    ) : (
                      `${transactionMode === "DEPOSIT" ? "Post deposit" : "Review withdrawal"}`
                    )}
                  </button>
                  <p className="transaction-security-note">
                    Transactions are recorded atomically and require an active staff session.
                  </p>
                </form>

                <section className="transaction-history" aria-labelledby="history-title">
                  <div className="directory-heading">
                    <div>
                      <h2 id="history-title">Recent activity</h2>
                      <p>Latest 50 stored transactions for this account.</p>
                    </div>
                    <span className="directory-count">{transactionHistory.length} shown</span>
                  </div>
                  {!selectedAccountNumber ? (
                    <div className="table-message">Select an account to view its activity.</div>
                  ) : transactionHistoryLoading ? (
                    <div className="table-message">Loading transaction history...</div>
                  ) : transactionHistory.length === 0 ? (
                    <div className="table-message">No transactions found for this account.</div>
                  ) : (
                    <div className="table-card">
                      <div className="table-scroll">
                        <table className="accounts-table transactions-table">
                          <thead>
                            <tr>
                              <th>Date / time</th>
                              <th>Reference</th>
                              <th>Type</th>
                              <th>Amount</th>
                              <th>Balance after</th>
                            </tr>
                          </thead>
                          <tbody>
                            {transactionHistory.map((transaction) => (
                              <tr key={transaction.transactionRef}>
                                <td>{new Date(transaction.createdAt).toLocaleString("en-IN")}</td>
                                <td className="transaction-reference">{transaction.transactionRef}</td>
                                <td>
                                  <span className={`transaction-type ${transaction.type === "DEPOSIT" ? "type-deposit" : "type-withdrawal"}`}>
                                    {transaction.type}
                                  </span>
                                </td>
                                <td>{money(transaction.amount)}</td>
                                <td className="balance-cell">{money(transaction.balanceAfter)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </section>
          )}

          {activeTab === "Reports" && (
            <section>
              <PageHeading
                eyebrow="BUSINESS INTELLIGENCE"
                title="Reports"
                description="View account summaries and transaction performance."
              />
              {reportError && <Notice notice={{ type: "error", text: reportError }} />}
              <form className="report-filters" onSubmit={(event) => event.preventDefault()}>
                <FormField label="From date" required>
                  <input
                    type="date"
                    value={reportDates.startDate}
                    onChange={(event) => setReportDates((previous) => ({ ...previous, startDate: event.target.value }))}
                    required
                  />
                </FormField>
                <FormField label="To date" required>
                  <input
                    type="date"
                    value={reportDates.endDate}
                    onChange={(event) => setReportDates((previous) => ({ ...previous, endDate: event.target.value }))}
                    required
                  />
                </FormField>
              </form>
              {reportLoading && <div className="table-message">Loading report data...</div>}
              {!reportLoading && reportData && (
                <div className="stats-grid report-stats">
                  <StatCard icon="＋" title="Total deposits" value={money(reportData.totalDeposits)} description="Selected date range" tone="green" />
                  <StatCard icon="−" title="Total withdrawals" value={money(reportData.totalWithdrawals)} description="Selected date range" tone="orange" />
                  <StatCard icon="▤" title="Active accounts" value={reportData.activeAccountCount} description="Current active accounts" tone="blue" />
                  <StatCard icon="⇄" title="Transactions" value={reportData.transactionCount} description="Selected date range" tone="purple" />
                </div>
              )}
              {!reportLoading && !reportData && !reportError && (
                <div className="table-message">Report data is unavailable until the API responds.</div>
              )}
              {reportData && (
                <div className="report-total-balance">
                  <span>Total balance across active accounts</span>
                  <strong>{money(reportData.totalBalance)}</strong>
                </div>
              )}
              <div className="report-disclaimer">
                Report totals are calculated from stored database transactions.
              </div>
            </section>
          )}

          {activeTab === "Administration" && currentUser.role === "ADMIN" && (
            <section>
              <PageHeading
                eyebrow="ACCESS CONTROL"
                title="Administration"
                description="Create staff accounts and manage assigned roles."
              />
              {notice && <Notice notice={notice} />}
              <form className="form-card staff-form" onSubmit={createStaff}>
                <div className="form-card-heading">
                  <div className="form-heading-icon">＋</div>
                  <div>
                    <h2>Create staff account</h2>
                    <p>Roles are assigned by administrators only.</p>
                  </div>
                </div>
                <div className="form-grid">
                  <FormField label="Username" required>
                    <input
                      value={staffForm.username}
                      onChange={(event) => setStaffForm((previous) => ({ ...previous, username: event.target.value }))}
                      minLength={3}
                      maxLength={64}
                      pattern="[A-Za-z0-9._-]+"
                      autoComplete="off"
                      required
                    />
                  </FormField>
                  <FormField label="Temporary password" required>
                    <input
                      type="password"
                      value={staffForm.password}
                      onChange={(event) => setStaffForm((previous) => ({ ...previous, password: event.target.value }))}
                      minLength={12}
                      maxLength={72}
                      autoComplete="new-password"
                      required
                    />
                    <small className="field-hint">At least 12 characters, no more than 72 bytes.</small>
                  </FormField>
                  <FormField label="Role" required>
                    <select
                      value={staffForm.role}
                      onChange={(event) => setStaffForm((previous) => ({ ...previous, role: event.target.value }))}
                    >
                      <option value="STAFF">Staff</option>
                      <option value="ADMIN">Administrator</option>
                    </select>
                  </FormField>
                  <button className="primary-button staff-create-button" type="submit">Create account</button>
                </div>
              </form>
              <div className="directory-heading">
                <div><h2>Staff accounts</h2><p>Password hashes are never returned by the API.</p></div>
                <span className="directory-count">{staff.length} staff</span>
              </div>
              <div className="table-card">
                {staffLoading ? <div className="table-message">Loading staff accounts...</div> : (
                  <div className="table-scroll">
                    <table className="accounts-table">
                      <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Failed attempts</th><th>Created</th></tr></thead>
                      <tbody>
                        {staff.map((person) => (
                          <tr key={person.userId}>
                            <td>{person.username}</td>
                            <td>
                              <select
                                aria-label={`Role for ${person.username}`}
                                value={person.role}
                                disabled={person.userId === currentUser.userId}
                                onChange={(event) => updateStaffRole(person.userId, event.target.value)}
                              >
                                <option value="STAFF">STAFF</option>
                                <option value="ADMIN">ADMIN</option>
                              </select>
                            </td>
                            <td>{person.isActive ? "Active" : "Disabled"}</td>
                            <td>{person.failedLoginAttempts}</td>
                            <td>{new Date(person.createdAt).toLocaleDateString("en-IN")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        <footer className="page-footer">
          <span>SecureBank Management System</span>
          <span>Local development · Not for real banking transactions</span>
        </footer>
      </main>
    </div>
  );
}

function Dashboard({ onOpenAccounts, onOpenTransactions, health, reportData, reportLoading, reportDates }) {
  return (
    <section>
      <PageHeading
        eyebrow="OVERVIEW"
        title="Dashboard"
        description="Welcome back. Here is your banking workspace overview."
      />

      <div className="hero-banner">
        <div className="hero-content">
          <div className="hero-tag"><span /> BANK OPERATIONS</div>
          <h2>Banking made clearer.</h2>
          <p>
            Manage customer onboarding and account operations from one
            centralized workspace.
          </p>
          <button className="hero-button" onClick={onOpenAccounts}>
            Open a new account <span>→</span>
          </button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-circle art-circle-one" />
          <div className="art-circle art-circle-two" />
          <div className="bank-card-illustration">
            <div className="art-card-top"><span>S</span><span>SECUREBANK</span></div>
            <div className="art-chip" />
            <div className="art-card-number">•••• &nbsp; •••• &nbsp; •••• &nbsp; 2048</div>
            <div className="art-card-bottom"><span>SECURE ACCOUNT</span><span>INR ₹</span></div>
          </div>
        </div>
      </div>

      <div className="section-heading">
        <div>
          <h2>Workspace status</h2>
          <p>System information and available modules</p>
        </div>
        <span className="date-chip">{reportDates.startDate} TO {reportDates.endDate}</span>
      </div>

      <div className="stats-grid">
        <StatCard
          icon="▤"
          title="Active accounts"
          value={reportLoading ? "Loading..." : reportData?.activeAccountCount ?? "Unavailable"}
          description="Current database count"
          tone="blue"
        />
        <StatCard
          icon="⇄"
          title="Transactions"
          value={reportLoading ? "Loading..." : reportData?.transactionCount ?? "Unavailable"}
          description="Selected report date range"
          tone="green"
        />
        <StatCard
          icon="＋"
          title="Deposits"
          value={reportLoading ? "Loading..." : reportData ? money(reportData.totalDeposits) : "Unavailable"}
          description="Selected report date range"
          tone="orange"
        />
        <StatCard
          icon="₹"
          title="Active account balance"
          value={reportLoading ? "Loading..." : reportData ? money(reportData.totalBalance) : "Unavailable"}
          description="Current database aggregate"
          tone="blue"
        />
      </div>

      <div className="dashboard-bottom">
        <div className="content-card quick-actions">
          <div className="card-title-row">
            <div>
              <h2>Quick actions</h2>
              <p>Common account management tasks</p>
            </div>
          </div>
          <button className="action-row" onClick={onOpenAccounts}>
            <span className="action-icon action-blue">＋</span>
            <span className="action-copy">
              <strong>Open new account</strong>
              <small>Register a customer and opening deposit</small>
            </span>
            <span className="action-arrow">→</span>
          </button>
          <button className="action-row" onClick={onOpenTransactions}>
            <span className="action-icon action-purple">⇄</span>
            <span className="action-copy">
              <strong>Post a transaction</strong>
              <small>Deposit or withdraw from an active account</small>
            </span>
            <span className="action-arrow">→</span>
          </button>
        </div>

        <div className="content-card system-card">
          <div className="card-title-row">
            <div>
              <h2>System health</h2>
              <p>Local development services</p>
            </div>
            <span className={`health-badge ${health === "Connected" ? "health-good" : ""}`}>
              {health}
            </span>
          </div>
          <div className="health-row">
            <span>React frontend</span>
            <strong><span className="status-dot dot-green" /> Running</strong>
          </div>
          <div className="health-row">
            <span>Report data</span>
            <strong>{reportLoading ? "Loading" : reportData ? "Available" : "Unavailable"}</strong>
          </div>
          <div className="health-row">
            <span>Express API</span>
            <strong><span className="status-dot dot-green" /> Configured</strong>
          </div>
          <div className="health-row">
            <span>MySQL database</span>
            <strong>
              <span className={`status-dot ${health === "Connected" ? "dot-green" : "dot-red"}`} />
              {health}
            </strong>
          </div>
          <div className="security-note">
            <span>⌑</span>
            Use fictional customer information for development tests.
          </div>
        </div>
      </div>
    </section>
  );
}

function LoginScreen({ onSubmit, loading, error, expired }) {
  const [passwordVisible, setPasswordVisible] = useState(false);

  return (
    <main className="login-shell">
      <section className="login-aside" aria-label="SecureBank">
        <button className="brand login-brand" type="button" aria-label="SecureBank">
          <span className="brand-mark">S</span>
          <span className="brand-copy">
            <strong>SecureBank</strong>
            <small>Banking platform</small>
          </span>
        </button>
        <div className="login-aside-copy">
          <span className="eyebrow">STAFF ACCESS</span>
          <h1>Bank operations, securely.</h1>
          <p>Sign in with your assigned staff credentials to continue.</p>
        </div>
        <span className="login-aside-foot">LOCAL DEVELOPMENT · AUTHENTICATED ACCESS</span>
      </section>

      <section className="login-main">
        <form className="login-card" onSubmit={onSubmit}>
          <div className="login-card-heading">
            <span className="eyebrow">SECURE SIGN IN</span>
            <h2>Welcome back</h2>
            <p>Use your username and password.</p>
          </div>
          {expired && (
            <div className="notice notice-error" role="alert">
              <span className="notice-symbol">!</span>
              <span>Your session expired. Sign in again to continue.</span>
            </div>
          )}
          {error && (
            <div className="notice notice-error" role="alert">
              <span className="notice-symbol">!</span>
              <span>{error}</span>
            </div>
          )}
          <label className="form-field">
            <span className="field-label">Username</span>
            <input
              name="username"
              autoComplete="username"
              minLength={3}
              maxLength={64}
              required
              autoFocus
            />
          </label>
          <label className="form-field">
            <span className="field-label">Password</span>
            <span className="login-password-field">
              <input
                name="password"
                type={passwordVisible ? "text" : "password"}
                autoComplete="current-password"
                maxLength={128}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setPasswordVisible((visible) => !visible)}
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                aria-pressed={passwordVisible}
              >
                {passwordVisible ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <button className="primary-button login-submit" type="submit" disabled={loading}>
            {loading ? <><span className="spinner" /> Signing in...</> : "Sign in"}
          </button>
          <p className="login-security-note">Access is managed by your bank administrator.</p>
        </form>
      </section>
    </main>
  );
}

function PageHeading({ eyebrow, title, description }) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function StatCard({ icon, title, value, description, tone }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon stat-${tone}`}>{icon}</div>
      <p className="stat-title">{title}</p>
      <h2>{value}</h2>
      <p className="stat-description">{description}</p>
    </article>
  );
}

function FormField({ label, required, wide, children }) {
  return (
    <label className={`form-field ${wide ? "field-wide" : ""}`}>
      <span className="field-label">
        {label} {required && <span className="required-star">*</span>}
      </span>
      {children}
    </label>
  );
}

function Notice({ notice }) {
  return (
    <div className={`notice notice-${notice.type}`} role="status">
      <span className="notice-symbol">
        {notice.type === "success" ? "✓" : "!"}
      </span>
      <span>{notice.text}</span>
    </div>
  );
}
