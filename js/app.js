const SUPABASE_URL = 'https://yreoztmcjylqlaonuadb.supabase.co';
        const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZW96dG1janlscWxhb251YWRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MjYyNjcsImV4cCI6MjExMTEwMjI2N30.4aOPvo2qZK0_iAs1gdekA_3Lqx6yO1v4C1kSB-djM0Y'; 
        window.platformAdmin = false;

        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        let currentUser = null;
        let currentBalance = 0;
        let selectedTaskForProof = null;
        let siteSettings = { points_per_dollar: 1000, min_withdraw: 1000, max_withdraw: 50000 };

        window.onload = async () => {
            await fetchSettings();
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) {
                await initUser(session.user);
            }
        };

        function toggleMenuDropdown() {
            document.getElementById('menu-dropdown').classList.toggle('hidden');
        }

        async function openNotificationsModal() {
            document.getElementById('notifications-modal').classList.remove('hidden');
            document.getElementById('notif-badge').classList.add('hidden');
            await fetchUserNotifications();
        }

        function closeNotificationsModal() {
            document.getElementById('notifications-modal').classList.add('hidden');
        }

        window.onclick = function(event) {
            if (!event.target.closest('button')) {
                const menu = document.getElementById('menu-dropdown');
                if (menu) menu.classList.add('hidden');
            }
        }

        async function fetchSettings() {
            const { data } = await supabaseClient.from('site_settings').select('*').eq('id', 1).single();
            if (data) {
                siteSettings = data;
                document.getElementById('wallet-min-badge').textContent = `الحد الأدنى: ${siteSettings.min_withdraw} نقطة`;
                document.getElementById('wallet-rate-text').textContent = `💵 كل ${siteSettings.points_per_dollar} نقطة = 1 دولار أمريكي`;
                document.getElementById('withdraw-amount').placeholder = `الحد الأدنى ${siteSettings.min_withdraw} - الأقصى ${siteSettings.max_withdraw}`;
            }
        }

        async function fetchUserNotifications() {
            if (!currentUser) return;
            const { data: notifs } = await supabaseClient
                .from('notifications')
                .select('*')
                .eq('user_id', currentUser.id)
                .order('created_at', { ascending: false });

            const notifList = document.getElementById('notifications-list');
            if (notifs && notifs.length > 0) {
                notifList.replaceChildren();
                notifs.forEach(n => {
                    const item = document.createElement('div');
                    item.className = 'bg-gray-900 p-2.5 rounded-xl border border-gray-800 text-xs text-gray-200';
                    item.textContent = n.message || '';
                    notifList.appendChild(item);
                });
            } else {
                notifList.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">لا توجد إشعارات جديدة</p>';
            }
        }

        async function handleAuth(type) {
            const email = document.getElementById('auth-email').value.trim();
            const password = document.getElementById('auth-password').value.trim();
            const msg = document.getElementById('auth-msg');
            msg.textContent = 'جاري المعالجة...';

            if (!email || !password) {
                msg.textContent = 'يرجى إدخال البريد الإلكتروني وكلمة المرور';
                return;
            }

            let res;
            if (type === 'login') {
                res = await supabaseClient.auth.signInWithPassword({ email, password });
            } else {
                res = await supabaseClient.auth.signUp({ email, password });
            }

            if (res.error) {
                msg.textContent = 'خطأ: ' + res.error.message;
            } else if (res.data.user) {
                await initUser(res.data.user);
            }
        }

        async function initUser(user) {
            currentUser = user;
            await fetchSettings();
            await fetchUserNotifications();
            
            const { data: unreadNotifs } = await supabaseClient
                .from('notifications')
                .select('id')
                .eq('user_id', user.id)
                .eq('is_read', false);
            if (unreadNotifs && unreadNotifs.length > 0) {
                document.getElementById('notif-badge').classList.remove('hidden');
            }
            
            let { data: profile } = await supabaseClient
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (!profile) {
                const { data: newProfile } = await supabaseClient
                    .from('profiles')
                    .insert([{ id: user.id, email: user.email, balance: 0, is_banned: false, ban_reason: '' }])
                    .select()
                    .single();
                profile = newProfile;
            }

            if (profile && profile.is_banned) {
                document.getElementById('auth-section').classList.add('hidden');
                document.getElementById('app-section').classList.add('hidden');
                document.getElementById('admin-section').classList.add('hidden');
                document.getElementById('banned-section').classList.remove('hidden');
                document.getElementById('ban-reason-text').textContent = profile.ban_reason || 'تم إيقاف هذا الحساب لمخالفة شروط الاستخدام.';
                return;
            }

            currentBalance = profile ? (profile.balance || 0) : 0;
            updateBalanceUI();

            document.getElementById('auth-section').classList.add('hidden');
            document.getElementById('app-section').classList.remove('hidden');

            await loadTasks();

            const { data: adminCheck, error: adminError } = await supabaseClient.rpc('is_platform_admin');
            window.platformAdmin = !adminError && adminCheck === true;
            if (window.platformAdmin) {
                document.getElementById('dropdown-admin-btn').classList.remove('hidden');
                document.getElementById('setting-rate').value = siteSettings.points_per_dollar;
                document.getElementById('setting-min').value = siteSettings.min_withdraw;
                document.getElementById('setting-max').value = siteSettings.max_withdraw;
                await loadAdminData();
            }

            // الاستماع اللحظي لتحديثات الرصيد
            supabaseClient
                .channel('public:profiles:id=eq.' + user.id)
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: 'id=eq.' + user.id }, payload => {
                    const newProfile = payload.new;
                    if (newProfile.is_banned) {
                        alert('🚫 تم حظر حسابك: ' + (newProfile.ban_reason || 'مخالفة الشروط'));
                        logout();
                    } else {
                        const diff = newProfile.balance - currentBalance;
                        currentBalance = newProfile.balance;
                        updateBalanceUI();
                        if (diff !== 0) {
                            if (diff > 0) alert(`🎉 مبروك! تمت إضافة ${diff} نقطة إلى حسابك.`);
                            else alert(`⚠️ تنبيه: تم خصم ${Math.abs(diff)} نقطة من حسابك.`);
                        }
                    }
                })
                .subscribe();

            // الاستماع اللحظي للإشعارات الجديدة لتنبيج الجرس فوراً
            supabaseClient
                .channel('public:notifications:user_id=eq.' + user.id)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + user.id }, payload => {
                    document.getElementById('notif-badge').classList.remove('hidden');
                    fetchUserNotifications();
                })
                .subscribe();
        }

        function openAdminPage() {
            if (window.platformAdmin !== true) {
                alert('ليس لديك صلاحية الوصول إلى لوحة الإدارة.');
                return;
            }
            document.getElementById('app-section').classList.add('hidden');
            document.getElementById('admin-section').classList.remove('hidden');
            window.scrollTo(0, 0);
            loadAdminData();
        }

        function closeAdminPage() {
            document.getElementById('admin-section').classList.add('hidden');
            document.getElementById('app-section').classList.remove('hidden');
            window.scrollTo(0, 0);
        }

        function updateBalanceUI() {
            document.getElementById('user-balance').textContent = currentBalance + ' نقطة';
            document.getElementById('dashboard-balance').textContent = currentBalance;
        }

        function switchTab(tab) {
            ['wallet', 'tasks', 'offers'].forEach(t => {
                document.getElementById('view-' + t).classList.add('hidden');
                const btn = document.getElementById('tab-' + t);
                btn.classList.remove('bg-emerald-500', 'text-black');
                btn.classList.add('bg-gray-800', 'text-gray-300');
            });

            document.getElementById('view-' + tab).classList.remove('hidden');
            const activeBtn = document.getElementById('tab-' + tab);
            activeBtn.classList.remove('bg-gray-800', 'text-gray-300');
            activeBtn.classList.add('bg-emerald-500', 'text-black');
        }

        async function loadTasks() {
            const tasksList = document.getElementById('tasks-list');
            
            const { data: tasks } = await supabaseClient
                .from('site_tasks')
                .select('*')
                .order('id', { ascending: false });

            const { data: submissions } = await supabaseClient
                .from('task_submissions')
                .select('task_id, status')
                .eq('user_id', currentUser.id);

            const subMap = {};
            if (submissions) {
                submissions.forEach(s => { subMap[s.task_id] = s.status; });
            }

            if (!tasks || tasks.length === 0) {
                tasksList.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">لا توجد مهام متاحة حالياً</p>';
                return;
            }

            tasksList.innerHTML = '';
            tasks.forEach(task => {
                const status = subMap[task.id];
                let btnHtml = '';

                if (status === 'pending') {
                    btnHtml = `<span class="text-[11px] bg-amber-500/20 text-amber-400 px-3 py-1.5 rounded-xl font-bold">⏳ قيد المراجعة</span>`;
                } else if (status === 'approved') {
                    btnHtml = `<span class="text-[11px] bg-emerald-500/20 text-emerald-400 px-3 py-1.5 rounded-xl font-bold">✅ تم التنفيذ</span>`;
                } else {
                    btnHtml = `<button onclick="openProofModal(${task.id}, '${task.title.replace(/'/g, "\\'")}', '${task.link}')" class="bg-emerald-500 hover:bg-emerald-600 text-black text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer">تنفيذ وإثبات</button>`;
                }

                tasksList.innerHTML += `
                    <div class="bg-gray-900/80 p-3.5 rounded-xl flex justify-between items-center border border-gray-800">
                        <div>
                            <p class="text-xs font-bold text-gray-100">${task.title}</p>
                            <span class="text-[11px] text-emerald-400 font-semibold">+${task.reward} نقطة</span>
                        </div>
                        ${btnHtml}
                    </div>
                `;
            });
        }

        function openProofModal(taskId, title, link) {
            selectedTaskForProof = { id: taskId, title: title };
            document.getElementById('modal-task-title').textContent = title;
            document.getElementById('proof-input').value = '';
            document.getElementById('proof-modal').classList.remove('hidden');
            window.open(link, '_blank');
        }

        function closeProofModal() {
            document.getElementById('proof-modal').classList.add('hidden');
            selectedTaskForProof = null;
        }

        async function submitProof() {
            const proofText = document.getElementById('proof-input').value.trim();
            if (!proofText) {
                alert('يرجى كتابة إثبات التنفيذ أولاً!');
                return;
            }

            const { error } = await supabaseClient
                .from('task_submissions')
                .insert([{
                    user_id: currentUser.id,
                    task_id: selectedTaskForProof.id,
                    user_email: currentUser.email,
                    task_title: selectedTaskForProof.title,
                    proof_text: proofText,
                    status: 'pending'
                }]);

            if (error) {
                alert('حدث خطأ: ' + error.message);
            } else {
                alert('✅ تم إرسال إثبات المهمة بنجاح، بانتظار مراجعة الأدمن!');
                closeProofModal();
                await loadTasks();
            }
        }


        async function requestWithdrawal(e) {
            e.preventDefault();
            const wallet = document.getElementById('withdraw-wallet').value.trim();
            const note = document.getElementById('withdraw-note').value.trim();
            const amount = Number(document.getElementById('withdraw-amount').value);
            const msg = document.getElementById('withdraw-msg');
            const btn = document.getElementById('withdraw-btn');

            if (!wallet || !Number.isSafeInteger(amount) || amount <= 0) {
                msg.className = 'text-center text-xs text-red-400 mt-1';
                msg.textContent = 'يرجى إدخال وسيلة السحب وعدد نقاط صحيح.';
                return;
            }
            if (amount < siteSettings.min_withdraw || amount > siteSettings.max_withdraw) {
                msg.className = 'text-center text-xs text-red-400 mt-1';
                msg.textContent = `يجب أن يكون السحب بين ${siteSettings.min_withdraw} و${siteSettings.max_withdraw} نقطة.`;
                return;
            }

            btn.disabled = true;
            btn.textContent = 'جاري إرسال الطلب...';
            msg.textContent = '';
            try {
                const fullWalletInfo = note ? `${wallet} - ملاحظة: ${note}` : wallet;
                const { data, error } = await supabaseClient.rpc('request_withdrawal', {
                    p_wallet_info: fullWalletInfo,
                    p_amount: amount
                });
                if (error) throw error;

                currentBalance = Number(data?.balance ?? (currentBalance - amount));
                updateBalanceUI();
                msg.className = 'text-center text-xs text-emerald-400 mt-1 font-bold';
                msg.textContent = '✅ تم تسجيل طلب السحب وخصم النقاط بنجاح.';
                document.getElementById('withdraw-wallet').value = '';
                document.getElementById('withdraw-note').value = '';
                document.getElementById('withdraw-amount').value = '';
                await loadAdminDataIfAdmin();
            } catch (err) {
                msg.className = 'text-center text-xs text-red-400 mt-1';
                msg.textContent = 'تعذر إرسال الطلب: ' + (err.message || 'حدث خطأ غير متوقع');
            } finally {
                btn.disabled = false;
                btn.textContent = 'إرسال طلب السحب';
            }
        }

        async function loadAdminDataIfAdmin() {
            if (window.platformAdmin === true) await loadAdminData();
        }

        function openOfferwall() {
            const placementId = window.RAB7NY_CONFIG?.AYET_PLACEMENT_ID;
            if (!placementId || placementId === 'YOUR_PLACEMENT_ID') {
                alert('يجب إضافة Placement ID الحقيقي الخاص بـ ayeT-Studios داخل js/config.js أولاً.');
                return;
            }
            const url = `https://www.ayetstudios.com/offers/web_offerwall/${encodeURIComponent(placementId)}?external_identifier=${encodeURIComponent(currentUser.id)}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert('📋 تم النسخ بنجاح: ' + text);
            }).catch(err => {
                alert('فشل النسخ!');
            });
        }

        // ================= دوال لوحة الأدمن =================
        async function updateSiteSettings(e) {
            e.preventDefault();
            const rate = parseInt(document.getElementById('setting-rate').value);
            const min = parseInt(document.getElementById('setting-min').value);
            const max = parseInt(document.getElementById('setting-max').value);
            const msg = document.getElementById('settings-msg');

            const { error } = await supabaseClient
                .from('site_settings')
                .update({ points_per_dollar: rate, min_withdraw: min, max_withdraw: max })
                .eq('id', 1);

            if (error) {
                msg.textContent = 'خطأ: ' + error.message;
            } else {
                msg.textContent = '✅ تم تحديث إعدادات المحفظة بنجاح!';
                await fetchSettings();
            }
        }

        async function addNewTask(e) {
            e.preventDefault();
            const title = document.getElementById('new-task-title').value.trim();
            const reward = parseInt(document.getElementById('new-task-reward').value);
            const link = document.getElementById('new-task-link').value.trim();
            const msg = document.getElementById('admin-msg');

            const { error } = await supabaseClient.from('site_tasks').insert([{ title, reward, link }]);
            if (!error) {
                msg.textContent = '✅ تم نشر المهمة بنجاح!';
                document.getElementById('new-task-title').value = '';
                document.getElementById('new-task-reward').value = '';
                document.getElementById('new-task-link').value = '';
                await loadTasks();
                await loadAdminData();
            }
        }

        async function loadAdminData() {
            const adminTasksList = document.getElementById('admin-tasks-list');
            const { data: tasks } = await supabaseClient.from('site_tasks').select('*').order('id', { ascending: false });

            if (tasks && tasks.length > 0) {
                adminTasksList.innerHTML = '';
                tasks.forEach(t => {
                    adminTasksList.innerHTML += `
                        <div class="bg-gray-900 p-3 rounded-xl border border-gray-800 flex justify-between items-center">
                            <div>
                                <p class="text-xs font-bold text-white">${t.title}</p>
                                <span class="text-[10px] text-emerald-400 font-semibold">${t.reward} نقطة</span>
                            </div>
                            <div class="flex gap-1.5">
                                <button onclick="openEditModal(${t.id}, '${t.title.replace(/'/g, "\\'")}', ${t.reward}, '${t.link}')" class="bg-amber-500/20 text-amber-400 text-[10px] font-bold px-3 py-1.5 rounded-lg cursor-pointer">تعديل</button>
                                <button onclick="deleteTask(${t.id})" class="bg-red-500/20 text-red-400 text-[10px] font-bold px-3 py-1.5 rounded-lg cursor-pointer">حذف</button>
                            </div>
                        </div>
                    `;
                });
            } else {
                adminTasksList.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">لا توجد مهام حالياً</p>';
            }

            const subsList = document.getElementById('admin-submissions-list');
            const { data: subs } = await supabaseClient.from('task_submissions').select('*').eq('status', 'pending').order('created_at', { ascending: false });

            if (subs && subs.length > 0) {
                subsList.innerHTML = '';
                subs.forEach(s => {
                    const safeProof = s.proof_text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    subsList.innerHTML += `
                        <div class="bg-gray-900 p-3 rounded-xl border border-gray-800 flex flex-col gap-2">
                            <div class="flex justify-between items-center">
                                <span class="text-[11px] font-bold text-emerald-400">${s.task_title || 'مهمة'}</span>
                                <span class="text-[10px] text-gray-400">${s.user_email || ''}</span>
                            </div>
                            <div class="flex justify-between items-center bg-gray-950 p-2 rounded-lg">
                                <p class="text-xs text-gray-300 truncate max-w-[200px]">الإثبات: <span class="text-amber-400 font-bold">${s.proof_text}</span></p>
                                <button onclick="copyToClipboard('${safeProof}')" class="bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-[10px] font-bold px-3 py-1.5 rounded-lg transition cursor-pointer">📋 نسخ الإثبات</button>
                            </div>
                            <button onclick="approveSubmission(${s.id}, '${s.user_id}', ${s.task_id})" class="bg-emerald-500 hover:bg-emerald-600 text-black text-xs font-bold py-2 rounded-xl transition cursor-pointer">✅ الموافقة وإضافة الأرباح</button>
                        </div>
                    `;
                });
            } else {
                subsList.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">لا توجد إثباتات معلقة</p>';
            }

            const wList = document.getElementById('admin-withdrawals-list');
            const { data: withdrawals } = await supabaseClient.from('withdrawals').select('*').order('created_at', { ascending: false });
            if (withdrawals && withdrawals.length > 0) {
                wList.innerHTML = '';
                withdrawals.forEach(w => {
                    wList.innerHTML += `
                        <div class="bg-gray-900 p-3 rounded-xl border border-gray-800 flex justify-between items-center">
                            <div>
                                <p class="text-[11px] font-bold text-white">${w.wallet_info}</p>
                                <p class="text-[10px] text-gray-400">${w.email} • <span class="text-amber-400 font-bold">${w.amount} نقطة</span></p>
                            </div>
                            <span class="text-[10px] px-2 py-1 rounded-lg bg-amber-500/20 text-amber-300">${w.status}</span>
                        </div>
                    `;
                });
            } else {
                wList.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">لا توجد طلبات سحب حالياً</p>';
            }

            const usersList = document.getElementById('admin-users-list');
            const { data: users } = await supabaseClient.from('profiles').select('*').order('balance', { ascending: false });
            if (users && users.length > 0) {
                usersList.innerHTML = '';
                users.forEach(u => {
                    const isBanned = u.is_banned === true;
                    usersList.innerHTML += `
                        <div class="bg-gray-900 p-3 rounded-xl border ${isBanned ? 'border-red-500/50' : 'border-gray-800'} flex flex-col gap-2">
                            <div class="flex justify-between items-center">
                                <span class="text-[11px] font-bold text-gray-200 truncate max-w-[180px]">${u.email || u.id}</span>
                                <span class="text-xs font-black text-emerald-400">${u.balance || 0} نقطة</span>
                            </div>
                            <div class="flex gap-1.5">
                                <button onclick="modifyUserBalance('${u.id}', 50)" class="flex-1 bg-emerald-500/20 text-emerald-400 text-[10px] font-bold py-1.5 rounded-lg cursor-pointer">+50 نقطة</button>
                                <button onclick="modifyUserBalance('${u.id}', -50)" class="flex-1 bg-amber-500/20 text-amber-400 text-[10px] font-bold py-1.5 rounded-lg cursor-pointer">-50 نقطة</button>
                                <button onclick="promptBanUser('${u.id}', ${isBanned})" class="flex-1 ${isBanned ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'} text-[10px] font-bold py-1.5 rounded-lg cursor-pointer">
                                    ${isBanned ? 'فك الحظر' : 'حظر'}
                                </button>
                            </div>
                        </div>
                    `;
                });
            } else {
                usersList.innerHTML = '<p class="text-xs text-gray-400 text-center py-2">لا توجد مستخدمين مسجلين</p>';
            }
        }

        function openEditModal(id, title, reward, link) {
            document.getElementById('edit-task-id').value = id;
            document.getElementById('edit-task-title').value = title;
            document.getElementById('edit-task-reward').value = reward;
            document.getElementById('edit-task-link').value = link;
            document.getElementById('edit-task-modal').classList.remove('hidden');
        }

        function closeEditModal() {
            document.getElementById('edit-task-modal').classList.add('hidden');
        }

        async function updateTaskData() {
            const id = document.getElementById('edit-task-id').value;
            const title = document.getElementById('edit-task-title').value.trim();
            const reward = parseInt(document.getElementById('edit-task-reward').value);
            const link = document.getElementById('edit-task-link').value.trim();

            if (!title || isNaN(reward) || !link) {
                alert('يرجى تعبئة كافة الحقول بشكل صحيح!');
                return;
            }

            const { error } = await supabaseClient
                .from('site_tasks')
                .update({ title, reward, link })
                .eq('id', id);

            if (error) {
                alert('حدث خطأ أثناء التعديل: ' + error.message);
            } else {
                alert('✅ تم تحديث المهمة بنجاح!');
                closeEditModal();
                await loadTasks();
                await loadAdminData();
            }
        }

        async function deleteTask(id) {
            if (!confirm('هل أنت متأكد من حذف هذه المهمة؟')) return;

            const { error } = await supabaseClient.from('site_tasks').delete().eq('id', id);
            if (!error) {
                alert('🗑️ تم حذف المهمة بنجاح!');
                await loadTasks();
                await loadAdminData();
            }
        }


        async function approveSubmission(subId) {
            if (!confirm('هل تريد الموافقة على الإثبات وإضافة المكافأة؟')) return;
            try {
                const { data, error } = await supabaseClient.rpc('approve_task_submission', {
                    p_submission_id: subId
                });
                if (error) throw error;
                alert(data?.message || '✅ تمت الموافقة وإضافة المكافأة مرة واحدة.');
                await loadAdminData();
                await loadTasks();
            } catch (err) {
                alert('تعذرت الموافقة: ' + (err.message || 'حدث خطأ غير متوقع'));
            }
        }

        async function modifyUserBalance(userId, change) {
            const reason = change > 0 ? `🎁 أضاف لك الأدمن ${change} نقطة إلى رصيدك.` : `⚠️ خصم الأدمن ${Math.abs(change)} نقطة من رصيدك.`;
            
            const { error } = await supabaseClient.rpc('admin_adjust_balance', {
                target_user_id: userId,
                points_change: change,
                reason_text: reason
            });

            if (error) {
                alert('خطأ في تعديل الرصيد: ' + error.message);
            } else {
                alert('✅ تم تعديل رصيد المستخدم بنجاح!');
                await loadAdminData();
            }
        }

        function promptBanUser(userId, currentStatus) {
            if (currentStatus) {
                toggleBanUser(userId, false, '');
            } else {
                document.getElementById('ban-user-id').value = userId;
                document.getElementById('ban-reason-input').value = 'تم حظر حسابك بسبب الغش أو تقديم إثبات غير صحيح';
                document.getElementById('ban-modal').classList.remove('hidden');
            }
        }

        function closeBanModal() {
            document.getElementById('ban-modal').classList.add('hidden');
        }

        async function confirmBanUser() {
            const userId = document.getElementById('ban-user-id').value;
            const reason = document.getElementById('ban-reason-input').value.trim() || 'مخالفة شروط الاستخدام';
            closeBanModal();
            await toggleBanUser(userId, true, reason);
        }

        async function toggleBanUser(userId, newStatus, reason) {
            const { error } = await supabaseClient.rpc('admin_set_user_ban', {
                target_user_id: userId,
                new_status: newStatus,
                reason_text: reason || ''
            });
            if (error) {
                alert('خطأ في تحديث حالة الحظر: ' + error.message);
            } else {
                await loadAdminData();
            }
        }

        async function logout() {
            try {
                await supabaseClient.auth.signOut();
            } catch(e){}
            location.reload();
        }
