import { createRoot } from 'react-dom/client';
import OwnerApp from './pages/owner/OwnerApp.jsx';
import './styles.css';

// Entry for the owner and guest screens on their own (development harness). At connection the main app mounts
// OwnerApp itself (PO-C13) and this file is not used.
createRoot(document.getElementById('root')).render(<OwnerApp />);
